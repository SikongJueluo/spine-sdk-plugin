import { Buffer } from "node:buffer";

import type {
  SamplingArchiveRecord,
  SpawnResult,
} from "@spinejit/spine-sdk";
import type { DomainFacility, DomainSpec } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

export const DEEPSEEK_HARNESS_LEDGER_SCHEMA = "spine.dsh.ledger.v1" as const;
export const DEEPSEEK_HARNESS_LEDGER_DOMAIN = "spine_dsh_ledger" as const;
export const DEEPSEEK_HARNESS_LEDGER_VERSION = 1 as const;

/** Durable archive payload, structurally identical to the session-event codec. */
export interface DeepSeekHarnessArchivePayload {
  schema: string;
  durabilityId: string;
  record: SamplingArchiveRecord;
}

interface DeepSeekHarnessLedgerEntryBase {
  schema: typeof DEEPSEEK_HARNESS_LEDGER_SCHEMA;
  sessionId: string;
  sessionCreatedAt: number;
  /** Monotonic per-session insertion order. */
  ordinal: number;
  /** `session.seq` at the moment the entry became durable. */
  anchorSeq: number;
}

export type DeepSeekHarnessLedgerEntry =
  | (DeepSeekHarnessLedgerEntryBase & {
      kind: "archive";
      archive: DeepSeekHarnessArchivePayload;
    })
  | (DeepSeekHarnessLedgerEntryBase & {
      kind: "spawn-terminal";
      batchId: string;
      result: SpawnResult;
    });

/**
 * Plugin-owned durable ledger.
 *
 * Spine state cannot live in `session/*` events: DSH accepts only event types
 * in its build-time vocabulary, and a writer cannot set the `ignorable` marker
 * through `Session.append`. The host's public answer for plugin data is
 * `ctx.storage.domain`, whose per-record writes resolve only after durability.
 */
export interface DeepSeekHarnessLedger {
  entries(sessionId: string, sessionCreatedAt: number): Promise<readonly DeepSeekHarnessLedgerEntry[]>;
  findSession(sessionId: string): Promise<{
    sessionCreatedAt: number;
    entries: readonly DeepSeekHarnessLedgerEntry[];
  } | undefined>;
  appendArchive(
    sessionId: string,
    sessionCreatedAt: number,
    anchorSeq: number,
    archive: DeepSeekHarnessArchivePayload,
  ): Promise<void>;
  appendSpawnTerminal(
    sessionId: string,
    sessionCreatedAt: number,
    anchorSeq: number,
    batchId: string,
    result: SpawnResult,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Narrow structural view of one opened DSH storage domain. */
export interface DeepSeekHarnessLedgerTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
}

export interface DeepSeekHarnessLedgerDomain {
  table(name: string): DeepSeekHarnessLedgerTable;
  close(): Promise<void>;
}

export class DeepSeekHarnessLedgerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepSeekHarnessLedgerError";
  }
}

const ledgerEntrySchema = z.object({
  schema: z.literal(DEEPSEEK_HARNESS_LEDGER_SCHEMA),
  sessionId: z.string().min(1),
  sessionCreatedAt: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative(),
  anchorSeq: z.number().int().nonnegative(),
  kind: z.enum(["archive", "spawn-terminal"]),
  archive: z.unknown().optional(),
  batchId: z.string().min(1).optional(),
  result: z.unknown().optional(),
}).strict();

/**
 * Domain declaration for the Spine ledger. `per-record` keeps one document per
 * journal entry, so appending an archive never rewrites the rest of the
 * session's ledger. Records are authoritative, so the default (reject on an
 * invalid record) is used instead of `backup-and-skip`.
 */
export const DEEPSEEK_HARNESS_LEDGER_DOMAIN_SPEC: DomainSpec = {
  name: DEEPSEEK_HARNESS_LEDGER_DOMAIN,
  version: DEEPSEEK_HARNESS_LEDGER_VERSION,
  layout: "per-record",
  tables: {
    entries: { valueSchema: ledgerEntrySchema },
  },
};

/** Open the ledger domain through the host storage facility. */
export async function openDeepSeekHarnessLedger(
  facility: Pick<DomainFacility, "open">,
): Promise<DeepSeekHarnessLedger> {
  const domain = await facility.open(DEEPSEEK_HARNESS_LEDGER_DOMAIN_SPEC) as unknown as DeepSeekHarnessLedgerDomain;
  return new DomainDeepSeekHarnessLedger(domain);
}

export class DomainDeepSeekHarnessLedger implements DeepSeekHarnessLedger {
  readonly #domain: DeepSeekHarnessLedgerDomain;
  readonly #table: DeepSeekHarnessLedgerTable;
  readonly #sessions = new Map<string, {
    createdAt: number;
    entries: DeepSeekHarnessLedgerEntry[];
    nextOrdinal: number;
  }>();
  /** One write chain per session: ordinal allocation, dedupe, put, and memory commit. */
  readonly #tails = new Map<string, Promise<void>>();
  #closed = false;

  constructor(domain: DeepSeekHarnessLedgerDomain) {
    this.#domain = domain;
    this.#table = domain.table("entries");
    for (const [key, raw] of this.#table.entries()) {
      const entry = decodeLedgerEntry(key, raw);
      this.#session(entry.sessionId, entry.sessionCreatedAt).entries.push(entry);
    }
    for (const state of this.#sessions.values()) {
      state.entries.sort((left, right) => left.ordinal - right.ordinal);
      state.nextOrdinal = state.entries.reduce(
        (next, entry) => Math.max(next, entry.ordinal + 1),
        0,
      );
    }
  }

  async entries(
    sessionId: string,
    sessionCreatedAt: number,
  ): Promise<readonly DeepSeekHarnessLedgerEntry[]> {
    this.#assertOpen();
    return [...this.#session(sessionId, sessionCreatedAt).entries];
  }

  async findSession(sessionId: string): Promise<{
    sessionCreatedAt: number;
    entries: readonly DeepSeekHarnessLedgerEntry[];
  } | undefined> {
    this.#assertOpen();
    const state = this.#sessions.get(sessionId);
    if (state === undefined) return undefined;
    return { sessionCreatedAt: state.createdAt, entries: [...state.entries] };
  }

  async appendArchive(
    sessionId: string,
    sessionCreatedAt: number,
    anchorSeq: number,
    archive: DeepSeekHarnessArchivePayload,
  ): Promise<void> {
    await this.#serialize(sessionId, async () => {
      const state = this.#session(sessionId, sessionCreatedAt);
      if (state.entries.some((entry) =>
        entry.kind === "archive" && entry.archive.durabilityId === archive.durabilityId)) {
        return;
      }
      await this.#append(sessionId, sessionCreatedAt, anchorSeq, { kind: "archive", archive });
    });
  }

  async appendSpawnTerminal(
    sessionId: string,
    sessionCreatedAt: number,
    anchorSeq: number,
    batchId: string,
    result: SpawnResult,
  ): Promise<void> {
    await this.#serialize(sessionId, async () => {
      const state = this.#session(sessionId, sessionCreatedAt);
      if (state.entries.some((entry) =>
        entry.kind === "spawn-terminal" &&
        entry.batchId === batchId &&
        entry.result.ordinal === result.ordinal)) {
        return;
      }
      await this.#append(sessionId, sessionCreatedAt, anchorSeq, {
        kind: "spawn-terminal",
        batchId,
        result,
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#domain.close();
  }

  async #append(
    sessionId: string,
    sessionCreatedAt: number,
    anchorSeq: number,
    body:
      | { kind: "archive"; archive: DeepSeekHarnessArchivePayload }
      | { kind: "spawn-terminal"; batchId: string; result: SpawnResult },
  ): Promise<void> {
    this.#assertOpen();
    const state = this.#session(sessionId, sessionCreatedAt);
    const entry: DeepSeekHarnessLedgerEntry = {
      schema: DEEPSEEK_HARNESS_LEDGER_SCHEMA,
      sessionId,
      sessionCreatedAt,
      ordinal: state.nextOrdinal,
      anchorSeq,
      ...body,
    } as DeepSeekHarnessLedgerEntry;
    await this.#table.put(ledgerKey(sessionId, entry.ordinal), entry);
    state.entries.push(entry);
    state.nextOrdinal += 1;
  }

  async #serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#tails.set(sessionId, current);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(sessionId) === current) this.#tails.delete(sessionId);
    }
  }

  #session(sessionId: string, sessionCreatedAt: number) {
    let state = this.#sessions.get(sessionId);
    if (state === undefined) {
      state = { createdAt: sessionCreatedAt, entries: [], nextOrdinal: 0 };
      this.#sessions.set(sessionId, state);
    } else if (state.createdAt !== sessionCreatedAt) {
      throw new DeepSeekHarnessLedgerError(
        `Spine ledger session "${sessionId}" belongs to a different session lifecycle`,
      );
    }
    return state;
  }

  #assertOpen(): void {
    if (this.#closed) throw new DeepSeekHarnessLedgerError("Spine ledger is closed");
  }
}

/** In-memory ledger for contract tests and minimal embeddings. */
export class MemoryDeepSeekHarnessLedger implements DeepSeekHarnessLedger {
  readonly #sessions = new Map<string, {
    createdAt: number;
    entries: DeepSeekHarnessLedgerEntry[];
  }>();
  #closed = false;

  async entries(
    sessionId: string,
    sessionCreatedAt: number,
  ): Promise<readonly DeepSeekHarnessLedgerEntry[]> {
    this.#assertOpen();
    return [...this.#session(sessionId, sessionCreatedAt).entries];
  }

  async findSession(sessionId: string): Promise<{
    sessionCreatedAt: number;
    entries: readonly DeepSeekHarnessLedgerEntry[];
  } | undefined> {
    this.#assertOpen();
    const state = this.#sessions.get(sessionId);
    if (state === undefined) return undefined;
    return { sessionCreatedAt: state.createdAt, entries: [...state.entries] };
  }

  async appendArchive(
    sessionId: string,
    sessionCreatedAt: number,
    anchorSeq: number,
    archive: DeepSeekHarnessArchivePayload,
  ): Promise<void> {
    const state = this.#session(sessionId, sessionCreatedAt);
    if (state.entries.some((entry) =>
      entry.kind === "archive" && entry.archive.durabilityId === archive.durabilityId)) {
      return;
    }
    this.#append(sessionId, sessionCreatedAt, anchorSeq, { kind: "archive", archive });
  }

  async appendSpawnTerminal(
    sessionId: string,
    sessionCreatedAt: number,
    anchorSeq: number,
    batchId: string,
    result: SpawnResult,
  ): Promise<void> {
    const state = this.#session(sessionId, sessionCreatedAt);
    if (state.entries.some((entry) =>
      entry.kind === "spawn-terminal" &&
      entry.batchId === batchId &&
      entry.result.ordinal === result.ordinal)) {
      return;
    }
    this.#append(sessionId, sessionCreatedAt, anchorSeq, {
      kind: "spawn-terminal",
      batchId,
      result,
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #append(
    sessionId: string,
    sessionCreatedAt: number,
    anchorSeq: number,
    body:
      | { kind: "archive"; archive: DeepSeekHarnessArchivePayload }
      | { kind: "spawn-terminal"; batchId: string; result: SpawnResult },
  ): void {
    this.#assertOpen();
    const state = this.#session(sessionId, sessionCreatedAt);
    state.entries.push({
      schema: DEEPSEEK_HARNESS_LEDGER_SCHEMA,
      sessionId,
      sessionCreatedAt,
      ordinal: state.entries.length,
      anchorSeq,
      ...body,
    } as DeepSeekHarnessLedgerEntry);
  }

  #session(sessionId: string, sessionCreatedAt: number) {
    let state = this.#sessions.get(sessionId);
    if (state === undefined) {
      state = { createdAt: sessionCreatedAt, entries: [] };
      this.#sessions.set(sessionId, state);
    } else if (state.createdAt !== sessionCreatedAt) {
      throw new DeepSeekHarnessLedgerError(
        `Spine ledger session "${sessionId}" belongs to a different session lifecycle`,
      );
    }
    return state;
  }

  #assertOpen(): void {
    if (this.#closed) throw new DeepSeekHarnessLedgerError("Spine ledger is closed");
  }
}

function ledgerKey(sessionId: string, ordinal: number): string {
  return `${Buffer.from(sessionId, "utf8").toString("base64url")}_${String(ordinal).padStart(16, "0")}`;
}

function decodeLedgerEntry(key: string, value: unknown): DeepSeekHarnessLedgerEntry {
  const result = ledgerEntrySchema.safeParse(value);
  if (!result.success) {
    throw new DeepSeekHarnessLedgerError(
      `Spine ledger record "${key}" is invalid`,
      { cause: result.error },
    );
  }
  return value as DeepSeekHarnessLedgerEntry;
}
