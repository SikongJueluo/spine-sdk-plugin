import {
  assertSafeIntegers,
  type JsonValue,
  type SamplingArchiveRecord,
  type SpawnResult,
  type SpawnTask,
  type SpineRuntimeClient,
} from "@spinejit/spine-sdk";
import type { Session, SessionStore } from "@deepseek-ai/dsh-session";

import {
  createHostAdapter,
  type HostArchiveEnvelope,
  type HostContextEnvelope,
  type HostOwnershipClaim,
  type PublishedContext,
  type SpawnStagingStore,
  type SpineHostAdapter,
} from "../index.js";
import { recoverStagedSpawnResults } from "../spawn.js";
import type { DeepSeekHarnessMessage } from "./dsh.js";
import {
  type DeepSeekHarnessArchivePayload,
  type DeepSeekHarnessLedger,
  type DeepSeekHarnessLedgerEntry,
} from "./ledger.js";
import {
  materializeDeepSeekHarnessContext,
  type DeepSeekHarnessSourceBindings,
} from "./messages.js";
import {
  DeepSeekHarnessDurabilityError,
  DeepSeekHarnessSurfacePublisher,
} from "./publisher.js";

export * from "./audit.js";
export * from "./dsh.js";
export * from "./history.js";
export * from "./inspection.js";
export * from "./ledger.js";
export * from "./lifecycle.js";
export * from "./messages.js";
export * from "./publisher.js";
export * from "./recovery.js";
export * from "./requests.js";
export * from "./view.js";

export const DEEPSEEK_HARNESS_ADAPTER_ID = "spine-plugin/deepseek-harness/v1" as const;
export interface DeepSeekHarnessArchiveEvent {
  schema: typeof DEEPSEEK_HARNESS_ADAPTER_ID;
  durabilityId: string;
  record: SamplingArchiveRecord;
}

export interface DeepSeekHarnessSpawnTerminalEvent {
  schema: typeof DEEPSEEK_HARNESS_ADAPTER_ID;
  batchId: string;
  result: SpawnResult;
}

/**
 * Host-facing Spine port for one DSH session.
 *
 * Archive and staging records go to the plugin-owned durable ledger, never into
 * the session log: the host accepts only its build-time event vocabulary and
 * offers no writer-controlled `ignorable` marker. Context publication uses
 * native surface events through {@link DeepSeekHarnessSurfacePublisher}.
 */
export interface DeepSeekHarnessSpinePort {
  claimOwnership(claim: HostOwnershipClaim): Promise<void>;
  persistArchive(entry: HostArchiveEnvelope): Promise<void>;
  persistSpawnTerminal(batchId: string, result: SpawnResult): Promise<void>;
  materializeContext(context: PublishedContext): Promise<readonly DeepSeekHarnessMessage[]>;
  publishAtomicSurface(context: HostContextEnvelope<DeepSeekHarnessMessage>): Promise<void>;
  isPublishedSeq(seq: number): boolean;
}

export interface CreateDeepSeekHarnessSessionPortOptions {
  session: Session;
  sessions: SessionStore;
  ledger: DeepSeekHarnessLedger;
  bindings: DeepSeekHarnessSourceBindings;
  claimOwnership?(claim: HostOwnershipClaim): Promise<void>;
}

export { DeepSeekHarnessDurabilityError };

export function createDeepSeekHarnessSessionPort(
  options: CreateDeepSeekHarnessSessionPortOptions,
): DeepSeekHarnessSpinePort {
  const { session, sessions, ledger, bindings } = options;
  const createdAt = session.header.createdAt;
  const publisher = new DeepSeekHarnessSurfacePublisher(
    session,
    sessions,
    (messageId) => bindings.origin(messageId),
  );
  return {
    claimOwnership: (claim) => options.claimOwnership?.(claim) ?? Promise.resolve(),
    persistArchive: async (entry) => {
      const archive: DeepSeekHarnessArchivePayload = {
        schema: DEEPSEEK_HARNESS_ADAPTER_ID,
        durabilityId: entry.durabilityId,
        record: entry.record,
      };
      decodeArchiveEvent(archive as unknown as JsonValue);
      // Never let the ledger get ahead of the host log: recovery merges the
      // archive against source observations, so the sources it cites must be
      // durable first. A crash after this flush loses only the archive.
      if (!await sessions.flush(session)) {
        throw new DeepSeekHarnessDurabilityError();
      }
      await ledger.appendArchive(session.id, createdAt, session.seq, archive);
    },
    persistSpawnTerminal: async (batchId, result) => {
      decodeSpawnTerminalEvent({
        schema: DEEPSEEK_HARNESS_ADAPTER_ID,
        batchId,
        result,
      });
      await ledger.appendSpawnTerminal(session.id, createdAt, session.seq, batchId, result);
    },
    materializeContext: (context) =>
      Promise.resolve(materializeDeepSeekHarnessContext(context, bindings)),
    publishAtomicSurface: async (context) => {
      // A null plan means the host has no compiled context, not "the context is
      // empty"; publishing it would hide live history.
      if (context.contextPlan === null) return;
      await publisher.publish(context.messages);
    },
    isPublishedSeq: (seq) => publisher.isOwnSeq(seq),
  };
}

export function createDeepSeekHarnessSpawnStagingStore(
  host: DeepSeekHarnessSpinePort,
): SpawnStagingStore {
  return {
    persistTerminal: (batchId, result) => host.persistSpawnTerminal(batchId, result),
  };
}

export function recoverDeepSeekHarnessSpawnResults(
  entries: readonly DeepSeekHarnessLedgerEntry[],
  batchId: string,
  tasks: readonly SpawnTask[],
): SpawnResult[] {
  const staged = entries
    .filter((entry): entry is Extract<DeepSeekHarnessLedgerEntry, { kind: "spawn-terminal" }> =>
      entry.kind === "spawn-terminal")
    .filter((entry) => entry.batchId === batchId)
    .map((entry) => entry.result);
  return recoverStagedSpawnResults(tasks, staged);
}

export interface DeepSeekHarnessSpineAdapterOptions {
  enabled: boolean;
  runtime: SpineRuntimeClient;
  host: DeepSeekHarnessSpinePort;
}

export async function createDeepSeekHarnessSpineAdapter(
  options: DeepSeekHarnessSpineAdapterOptions,
): Promise<SpineHostAdapter | null> {
  if (!options.enabled) {
    return null;
  }
  return createHostAdapter({
    runtime: options.runtime,
    host: {
      claimOwnership: (claim) => options.host.claimOwnership(claim),
      persistArchive: (entry) => options.host.persistArchive(entry),
      context: {
        materialize: (context) => options.host.materializeContext(context),
        publishAtomic: (context) => options.host.publishAtomicSurface(context),
      },
    },
  });
}

function decodeArchiveEvent(data: JsonValue): void {
  if (!isRecord(data) || data.schema !== DEEPSEEK_HARNESS_ADAPTER_ID) {
    throw new Error("invalid Spine archive schema");
  }
  if (typeof data.durabilityId !== "string" || data.durabilityId.length === 0) {
    throw new Error("invalid Spine archive durability identity");
  }
  if (!isRecord(data.record) || !isRecord(data.record.record)) {
    throw new Error("invalid Spine archive record");
  }
  if (data.record.type !== "sampling_started" && data.record.type !== "sampling_commit") {
    throw new Error("unknown Spine archive record type");
  }
  const record = data.record.record;
  if (
    !isRecord(record.attempt_id) ||
    typeof record.attempt_id.thread !== "string" ||
    record.attempt_id.thread.length === 0
  ) {
    throw new Error("inconsistent Spine archive identity");
  }
  if (data.record.type === "sampling_started") {
    assertSamplingStarted(record);
  } else {
    assertSamplingCommit(record);
  }
  assertSafeIntegers(data);
}

function assertSamplingStarted(record: Record<string, unknown>): void {
  if (
    record.schema !== "spine.sampling.started" ||
    !isNonNegativeInteger(record.epoch) ||
    !isEpochOrdinalId(record.pre_boundary) ||
    !isNamespacedId(record.attempt_id) ||
    !isNullableNamespacedId(record.previous_commit_id)
  ) {
    throw new Error("malformed Spine sampling-started record");
  }
}

function assertSamplingCommit(record: Record<string, unknown>): void {
  if (
    record.schema !== "spine.sampling.commit" ||
    !isNamespacedId(record.attempt_id) ||
    !isNamespacedId(record.commit_id) ||
    !isNonNegativeInteger(record.epoch) ||
    !(record.previous_pre_boundary === null || isEpochOrdinalId(record.previous_pre_boundary)) ||
    !isEpochOrdinalId(record.pre_boundary) ||
    !isEpochOrdinalId(record.post_boundary) ||
    !isNullableNamespacedId(record.previous_commit_id) ||
    !Array.isArray(record.executions)
  ) {
    throw new Error("malformed Spine sampling-commit record");
  }
  if (record.input_tokens !== undefined && !isNonNegativeInteger(record.input_tokens)) {
    throw new Error("malformed Spine sampling-commit input token count");
  }
  for (const execution of record.executions) assertCommittedExecution(execution);
}

function assertCommittedExecution(value: unknown): void {
  if (!isRecord(value)) throw new Error("malformed committed Spine execution");
  if (
    !isNamespacedId(value.execution_id) ||
    !isNonNegativeInteger(value.ordinal) ||
    !isRecord(value.origin) ||
    value.origin.type !== "direct" ||
    !isNonEmptyString(value.origin.execution_ref) ||
    !isRecord(value.source_span) ||
    !isEpochOrdinalId(value.source_span.start) ||
    !isEpochOrdinalId(value.source_span.end) ||
    !isRecord(value.operation)
  ) {
    throw new Error("malformed committed Spine execution");
  }
  assertSpineOperation(value.operation);
}

function assertSpineOperation(operation: Record<string, unknown>): void {
  switch (operation.type) {
    case "open":
      if (!isNonEmptyString(operation.summary)) throw new Error("malformed Spine Open operation");
      return;
    case "close":
      if (!isNonEmptyString(operation.memory)) throw new Error("malformed Spine Close operation");
      return;
    case "next":
      if (!isNonEmptyString(operation.closed_memory) || !isNonEmptyString(operation.next_summary)) {
        throw new Error("malformed Spine Next operation");
      }
      return;
    case "spawn":
      if (!Array.isArray(operation.tasks) || !Array.isArray(operation.terminal_results)) {
        throw new Error("malformed Spine Spawn operation");
      }
      for (const task of operation.tasks) {
        if (!isRecord(task) || !isNonEmptyString(task.summary) || !isNonEmptyString(task.prompt)) {
          throw new Error("malformed Spine Spawn task");
        }
      }
      for (const result of operation.terminal_results) {
        decodeSpawnTerminalEvent({
          schema: DEEPSEEK_HARNESS_ADAPTER_ID,
          batchId: "archive-validation",
          result,
        });
      }
      return;
    default:
      throw new Error("unknown Spine operation type");
  }
}

function decodeSpawnTerminalEvent(data: unknown): DeepSeekHarnessSpawnTerminalEvent {
  if (
    !isRecord(data) ||
    data.schema !== DEEPSEEK_HARNESS_ADAPTER_ID ||
    typeof data.batchId !== "string" ||
    data.batchId.length === 0 ||
    !isRecord(data.result)
  ) {
    throw new Error("malformed Spine Spawn terminal staging");
  }
  const result = data.result;
  if (
    !Number.isSafeInteger(result.ordinal) ||
    (result.ordinal as number) < 0 ||
    (result.outcome !== "completed" && result.outcome !== "errored" && result.outcome !== "aborted") ||
    typeof result.memory_body !== "string" ||
    result.memory_body.trim().length === 0
  ) {
    throw new Error("invalid Spine Spawn terminal result");
  }
  if (
    result.outcome !== "completed" &&
    (typeof result.diagnostic !== "string" || result.diagnostic.trim().length === 0)
  ) {
    throw new Error("non-completed Spine Spawn terminal requires a diagnostic");
  }
  if (
    result.execution_ref !== undefined &&
    result.execution_ref !== null &&
    (typeof result.execution_ref !== "string" || result.execution_ref.trim().length === 0)
  ) {
    throw new Error("invalid Spine Spawn execution reference");
  }
  assertSafeIntegers(data);
  return data as unknown as DeepSeekHarnessSpawnTerminalEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNamespacedId(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.thread) && isNonEmptyString(value.value);
}

function isNullableNamespacedId(value: unknown): boolean {
  return value === null || isNamespacedId(value);
}

function isEpochOrdinalId(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyString(value.thread) &&
    isNonNegativeInteger(value.epoch) &&
    isNonNegativeInteger(value.ordinal);
}
