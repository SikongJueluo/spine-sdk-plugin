/**
 * Read-only inspection service for the Spine Tree view.
 *
 * The service owns no Spine state of its own: live projections arrive from the
 * sampling lifecycle (preview / publish / commit), historical trees are rebuilt
 * from the log plus ledger in a disposable runtime, and request evidence comes
 * from the plugin-owned audit store. Every method is a read except the
 * `report*` methods the extension calls while a normal step is already running.
 */
import type {
  ContextPlanRecipe,
  SpineProjection,
} from "@spinejit/spine-sdk";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

import type { PublishedContext } from "../controller.js";
import type { DeepSeekHarnessLedger, DeepSeekHarnessLedgerEntry } from "./ledger.js";
import {
  reconstructSpineTree,
  type DisposableSpineRuntime,
  type HistoricalSpineTree,
} from "./history.js";
import {
  freezeRequest,
  summarizeRequest,
  type CapturedRequestRecord,
  type DeepSeekHarnessRequestStore,
} from "./requests.js";
import {
  buildTreeView,
  ledgerCounts,
  unavailableTree,
  SPINE_VIEW_SCHEMA,
  type SpineRequestSummary,
  type SpineSessionView,
  type SpineTreeView,
} from "./view.js";

export const SPINE_INSPECTION_SERVICE = "spineInspection" as const;

/**
 * Structural test for a request assembled by `dsh-agent-loop`.
 *
 * The Host marks loop requests in a module-private `WeakSet`
 * (`isAgentLoopRequest`), which a separately loaded plugin copy cannot see.
 * A loop-built request is instead recognizable by its own contract: it carries
 * the loop's Session identity, has no auxiliary `purpose`, and passes the
 * system prompt as the leading system-role message instead of `system`.
 */
export function looksLikeLoopRequest(request: unknown, sessionId: string): boolean {
  if (request === null || typeof request !== "object") return false;
  const candidate = request as {
    sessionId?: unknown;
    purpose?: unknown;
    system?: unknown;
    messages?: unknown;
  };
  if (String(candidate.sessionId ?? "") !== sessionId) return false;
  if (candidate.purpose !== undefined) return false;
  if (candidate.system !== undefined) return false;
  if (!Array.isArray(candidate.messages) || candidate.messages.length === 0) return false;
  const first = candidate.messages[0] as { role?: unknown } | null;
  return first !== null && typeof first === "object" && first.role === "system";
}
export const SPINE_INSPECTION_SCHEMA = "spine.dsh.inspect.v1" as const;

export interface SpineViewRequest {
  /** Return `unchanged` when the caller already holds this revision. */
  since?: number | undefined;
}

export type SpineViewResponse =
  | { revision: number; unchanged: true }
  | (SpineSessionView & { unchanged?: false });

export interface SpineRequestDetailView {
  schema: string;
  sessionId: string;
  summary: SpineRequestSummary;
  record: CapturedRequestRecord;
}

export interface SpineRequestDetailResponse {
  ok: boolean;
  reason: string | null;
  detail: SpineRequestDetailView | null;
}

export interface SpineInspectionService {
  readonly schema: typeof SPINE_INSPECTION_SCHEMA;
  view(sessionId: string, request?: SpineViewRequest): Promise<SpineViewResponse>;
  request(sessionId: string, requestId: string): Promise<SpineRequestDetailResponse>;
  close(): Promise<void>;
}

export interface SpineInspectionOptions {
  ledger: () => Promise<DeepSeekHarnessLedger>;
  /** Undefined disables request evidence; a rejected promise reports an error. */
  requests: (() => Promise<DeepSeekHarnessRequestStore>) | undefined;
  /** Events of a Session that is not live, or null when its log is unavailable. */
  inspectSession: (sessionId: string) => Promise<{
    events: readonly SessionEvent[];
    createdAt: number;
  } | null>;
  runtimeFactory: (thread: string) => DisposableSpineRuntime;
  now?: () => number;
}

interface PendingPlan {
  id: string;
  plan: ContextPlanRecipe;
  projection: SpineProjection;
  at: number;
  attempts: number;
}

interface LiveSession {
  sessionId: string;
  session: Session;
  createdAt: number;
  projection: SpineProjection | null;
  contextPlan: ContextPlanRecipe | null;
  thread: string | null;
  epoch: number | null;
  updatedAt: number;
  sampling: boolean;
  activity: string | null;
  fault: { message: string; since: number } | null;
  pending: PendingPlan | null;
  planSeq: number;
}

interface ColdSnapshot {
  key: string;
  tree: SpineTreeView;
  entries: readonly DeepSeekHarnessLedgerEntry[];
}

export class DeepSeekHarnessInspection implements SpineInspectionService {
  readonly schema = SPINE_INSPECTION_SCHEMA;
  readonly #options: SpineInspectionOptions;
  readonly #live = new Map<string, LiveSession>();
  readonly #cold = new Map<string, ColdSnapshot>();
  readonly #revisions = new Map<string, number>();
  readonly #snapshots = new Map<string, { revision: number; view: SpineSessionView }>();
  readonly #building = new Map<string, { revision: number; promise: Promise<SpineSessionView> }>();
  readonly #requestErrors = new Map<string, string>();
  #requestStore: Promise<DeepSeekHarnessRequestStore> | null = null;
  #requestStoreError: string | null = null;
  #closed = false;

  constructor(options: SpineInspectionOptions) {
    this.#options = options;
  }

  /** Start opening request evidence in the background; failures surface in the view. */
  start(): void {
    if (this.#options.requests === undefined) return;
    void this.#requestStorage().catch(() => undefined);
  }

  attach(session: Session): void {
    const sessionId = String(session.id);
    const existing = this.#live.get(sessionId);
    if (existing !== undefined && existing.session === session) return;
    this.#live.set(sessionId, {
      sessionId,
      session,
      createdAt: session.header.createdAt,
      projection: null,
      contextPlan: null,
      thread: null,
      epoch: null,
      updatedAt: this.#now(),
      sampling: false,
      activity: null,
      fault: null,
      pending: null,
      planSeq: 0,
    });
    this.#cold.delete(sessionId);
    this.#bump(sessionId);
  }

  detach(sessionId: string): void {
    if (!this.#live.delete(sessionId)) return;
    this.#cold.delete(sessionId);
    this.#bump(sessionId);
  }

  /**
   * Observe one context the lifecycle produced.
   *
   * Both a `preview` and a successful `commit` establish the complete plan of
   * record for the next request:
   *
   * - `preview` runs before a step that admits new input, and its full plan is
   *   what that request is assembled from (only its pre-input prefix is
   *   published).
   * - `commit` runs after a step commits, and its plan is the context the next
   *   request starts from. Ordinary tool continuations have no new input, so
   *   no preview follows; without this update the next request would be
   *   compared with the previous step's pre-assistant plan.
   *
   * `publish` only replaces the published prefix and must not become the plan
   * of record for a request.
   */
  reportContext(session: Session, context: PublishedContext, phase: "preview" | "publish" | "commit"): void {
    const live = this.#liveFor(session);
    if (live === null) return;
    live.projection = context.projection;
    if (context.contextPlan !== null) {
      live.contextPlan = context.contextPlan;
      live.thread = String(context.contextPlan.thread);
      live.epoch = context.contextPlan.epoch;
      if (phase === "preview" || phase === "commit") {
        live.planSeq += 1;
        live.pending = {
          id: `plan-${live.planSeq}`,
          plan: context.contextPlan,
          projection: context.projection,
          at: this.#now(),
          attempts: 0,
        };
      }
    }
    live.updatedAt = this.#now();
    if (phase === "commit") live.sampling = false;
    this.#bump(live.sessionId);
  }

  reportActivity(session: Session, sampling: boolean, activity: string | null): void {
    const live = this.#liveFor(session);
    if (live === null) return;
    live.sampling = sampling;
    live.activity = activity;
    live.updatedAt = this.#now();
    this.#bump(live.sessionId);
  }

  reportFault(session: Session, cause: unknown): void {
    const live = this.#liveFor(session);
    if (live === null) return;
    if (live.fault === null) {
      live.fault = { message: messageOf(cause), since: this.#now() };
      this.#bump(live.sessionId);
    }
  }

  /**
   * Capture one frozen loop request together with the plan that was current
   * when the Host assembled it.
   *
   * Persistence is fire-and-forget: a storage failure must never delay or alter
   * the model request. The failure is recorded and shown with the evidence.
   */
  captureRequest(
    session: Session,
    request: unknown,
    materialize: (plan: ContextPlanRecipe, projection: SpineProjection) => readonly unknown[],
  ): CapturedRequestRecord | null {
    const live = this.#liveFor(session);
    if (live === null) return null;
    const pending = live.pending;
    let expected: readonly unknown[] | null = null;
    let planError: string | null = null;
    if (pending !== null) {
      try {
        expected = materialize(pending.plan, pending.projection);
      } catch (error) {
        planError = `Spine plan could not be materialized for comparison: ${messageOf(error)}`;
      }
    }
    const capturedAt = this.#now();
    const attempt = pending === null ? 0 : ++pending.attempts;
    let record: CapturedRequestRecord;
    try {
      record = freezeRequest({
        sessionId: live.sessionId,
        sessionCreatedAt: live.createdAt,
        requestId: `${capturedAt.toString(36)}-${attempt}-${Math.random().toString(36).slice(2, 8)}`,
        capturedAt,
        purpose: purposeOf(request),
        attempt,
        planId: pending?.id ?? null,
        request,
        plan: pending?.plan ?? null,
        expected,
        planError,
      });
    } catch (error) {
      this.#requestErrors.set(live.sessionId, `Request capture failed: ${messageOf(error)}`);
      this.#bump(live.sessionId);
      return null;
    }
    // Revision moves only once the record is readable from the store; bumping
    // earlier would cache a view whose request list cannot contain it yet and
    // the client's `since` poll would then never see the persisted evidence.
    void this.#persist(record).then(() => {
      if (!this.#closed) this.#bump(live.sessionId);
    }).catch((error: unknown) => {
      this.#requestErrors.set(live.sessionId, `Request evidence could not be stored: ${messageOf(error)}`);
      if (!this.#closed) this.#bump(live.sessionId);
    });
    return record;
  }

  async view(sessionId: string, request: SpineViewRequest = {}): Promise<SpineViewResponse> {
    this.#assertOpen();
    const live = this.#live.get(sessionId);
    const ready = this.#isReady(sessionId, live);
    let revision = this.#revisions.get(sessionId);
    if (revision === undefined || !ready) {
      revision = this.#bump(sessionId);
    }
    if (request.since !== undefined && request.since === revision) {
      return { revision, unchanged: true };
    }
    const cached = this.#snapshots.get(sessionId);
    if (cached !== undefined && cached.revision === revision) return cached.view;
    const inflight = this.#building.get(sessionId);
    if (inflight !== undefined && inflight.revision === revision) return inflight.promise;
    const promise = this.#build(sessionId, live, revision).then((view) => {
      if (!this.#closed) this.#snapshots.set(sessionId, { revision, view });
      return view;
    }).finally(() => {
      if (this.#building.get(sessionId)?.promise === promise) this.#building.delete(sessionId);
    });
    this.#building.set(sessionId, { revision, promise });
    return promise;
  }

  async request(sessionId: string, requestId: string): Promise<SpineRequestDetailResponse> {
    this.#assertOpen();
    if (this.#options.requests === undefined) {
      return { ok: false, reason: "Request evidence is disabled for this Host.", detail: null };
    }
    let store: DeepSeekHarnessRequestStore;
    try {
      store = await this.#requestStorage();
    } catch (error) {
      return { ok: false, reason: `Request evidence is unavailable: ${messageOf(error)}`, detail: null };
    }
    const record = store.detail(sessionId, requestId);
    if (record === null) {
      return { ok: false, reason: "No captured evidence exists for this request.", detail: null };
    }
    return {
      ok: true,
      reason: null,
      detail: {
        schema: record.schema,
        sessionId,
        summary: summarizeRequest(record),
        record,
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const store = this.#requestStore;
    this.#requestStore = null;
    if (store !== null) await store.then((open) => open.close()).catch(() => undefined);
  }

  async #build(sessionId: string, live: LiveSession | undefined, revision: number): Promise<SpineSessionView> {
    const now = this.#now();
    let tree: SpineTreeView;
    let entries: readonly DeepSeekHarnessLedgerEntry[] = [];
    if (live !== undefined && live.projection !== null) {
      tree = buildTreeView(live.projection, {
        state: "live",
        evidence: "live",
        thread: live.thread,
        epoch: live.epoch,
      });
      entries = await this.#ledgerEntries(sessionId, live.createdAt);
    } else {
      const cold = await this.#reconstruct(sessionId, live);
      tree = cold.tree;
      entries = cold.entries;
    }
    const requests = await this.#requestSummaries(sessionId);
    const evidence = this.#evidenceState(sessionId);
    return {
      schema: SPINE_VIEW_SCHEMA,
      sessionId,
      revision,
      observedAt: now,
      host: { available: true, reason: null, message: null },
      spine: tree,
      activity: {
        sampling: live?.sampling ?? false,
        label: live?.activity ?? null,
      },
      fault: live?.fault ?? null,
      requests: requests.summaries,
      evidence: {
        store: evidence.store,
        captured: requests.summaries.length,
        message: evidence.message,
      },
      ledger: entries.length === 0 ? null : ledgerCounts(entries),
    };
  }

  async #reconstruct(sessionId: string, live: LiveSession | undefined): Promise<ColdSnapshot> {
    const key = live === undefined ? "cold" : `live:${live.session.seq}`;
    const cached = this.#cold.get(sessionId);
    if (cached !== undefined && cached.key === key) return cached;
    let events: readonly SessionEvent[];
    let createdAt: number;
    if (live !== undefined) {
      events = live.session.snapshotEvents();
      createdAt = live.createdAt;
    } else {
      let failure: string | null = null;
      const inspected = await this.#options.inspectSession(sessionId).catch((error: unknown) => {
        failure = messageOf(error);
        return null;
      });
      if (inspected === null) {
        const snapshot: ColdSnapshot = {
          key,
          tree: unavailableTree(
            failure === null
              ? "This Session is not live and its stored log could not be read; the tree cannot be reconstructed."
              : `This Session is not live and its stored log could not be read: ${failure}`,
          ),
          entries: [],
        };
        this.#cold.set(sessionId, snapshot);
        return snapshot;
      }
      events = inspected.events;
      createdAt = inspected.createdAt;
    }
    const recovered: HistoricalSpineTree = await reconstructSpineTree({
      sessionId,
      sessionCreatedAt: createdAt,
      events,
      ledger: this.#options.ledger,
      runtimeFactory: this.#options.runtimeFactory,
    });
    const tree = recovered.projection === null
      ? unavailableTree(recovered.reason ?? "Spine replay produced no projection.")
      : buildTreeView(recovered.projection, {
          state: "recovered",
          evidence: "reconstructed",
          note: "Rebuilt from the Session log and the Spine ledger. No Agent was resumed.",
          thread: recovered.thread,
          epoch: recovered.epoch,
        });
    const snapshot: ColdSnapshot = { key, tree, entries: recovered.entries };
    this.#cold.set(sessionId, snapshot);
    return snapshot;
  }

  async #requestSummaries(sessionId: string): Promise<{ summaries: SpineRequestSummary[] }> {
    if (this.#options.requests === undefined) return { summaries: [] };
    try {
      const store = await this.#requestStorage();
      return { summaries: store.summaries(sessionId) };
    } catch {
      return { summaries: [] };
    }
  }

  #evidenceState(sessionId: string): { store: "ok" | "unavailable" | "error"; message: string | null } {
    if (this.#options.requests === undefined) {
      return { store: "unavailable", message: "Request evidence is disabled for this Host." };
    }
    const failure = this.#requestErrors.get(sessionId) ?? this.#requestStoreError;
    if (failure !== null) return { store: "error", message: failure };
    return { store: "ok", message: null };
  }

  async #requestStorage(): Promise<DeepSeekHarnessRequestStore> {
    if (this.#options.requests === undefined) {
      throw new Error("Request evidence is disabled for this Host.");
    }
    if (this.#requestStore === null) {
      this.#requestStore = this.#options.requests().catch((error: unknown) => {
        this.#requestStoreError = `Spine request evidence is unreadable: ${messageOf(error)}`;
        throw error;
      });
    }
    return this.#requestStore;
  }

  async #persist(record: CapturedRequestRecord): Promise<void> {
    const store = await this.#requestStorage();
    await store.append(record);
  }

  async #ledgerEntries(
    sessionId: string,
    createdAt: number,
  ): Promise<readonly DeepSeekHarnessLedgerEntry[]> {
    try {
      const found = await (await this.#options.ledger()).findSession(sessionId);
      if (found === undefined || found.sessionCreatedAt !== createdAt) return [];
      return found.entries;
    } catch {
      return [];
    }
  }

  #liveFor(session: Session): LiveSession | null {
    const live = this.#live.get(String(session.id));
    if (live === undefined || live.session !== session) return null;
    return live;
  }

  #isReady(sessionId: string, live: LiveSession | undefined): boolean {
    if (live !== undefined && live.projection !== null) return true;
    const cold = this.#cold.get(sessionId);
    if (cold === undefined) return false;
    if (live === undefined) return true;
    return cold.key === `live:${live.session.seq}`;
  }

  #bump(sessionId: string): number {
    const next = (this.#revisions.get(sessionId) ?? 0) + 1;
    this.#revisions.set(sessionId, next);
    this.#snapshots.delete(sessionId);
    this.#building.delete(sessionId);
    return next;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Spine inspection service is closed");
  }
}

function purposeOf(request: unknown): string | null {
  if (request === null || typeof request !== "object") return null;
  const purpose = (request as { purpose?: unknown }).purpose;
  return typeof purpose === "string" ? purpose : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
