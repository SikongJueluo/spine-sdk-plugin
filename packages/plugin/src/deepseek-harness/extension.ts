import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent, UserMessage } from "@deepseek-ai/dsh-session";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { EpochOrdinalId, SpawnTask } from "@spinejit/spine-sdk";
import { createNodeSpineRuntime, type NodeSpineRuntime } from "@spinejit/spine-sdk/node";

import { executeSpawnBatch, type SpawnChildTerminal } from "../spawn.js";
import {
  decodeSpineSpawnTasks,
  operationFromSpineToolCall,
  SpineToolInputError,
  SPINE_TOOL_NAMES,
  type SpineToolName,
} from "../tools.js";
import {
  type DeepSeekHarnessMessage,
} from "./dsh.js";
import { loadSpineContract, type SpineToolContract } from "./contract.js";
import {
  createDeepSeekHarnessSessionPort,
  createDeepSeekHarnessSpawnStagingStore,
  createDeepSeekHarnessSpineAdapter,
  type DeepSeekHarnessSpinePort,
} from "./index.js";
import {
  DeepSeekHarnessInspection,
  SPINE_INSPECTION_HOST_SERVICE,
  looksLikeLoopRequest,
  type SpineInspectionContribution,
  type SpineInspectionHost,
} from "./inspection.js";
import { materializeDeepSeekHarnessContext } from "./messages.js";
import {
  DEFAULT_REQUEST_RETENTION,
  openDeepSeekHarnessRequestStore,
  type DeepSeekHarnessRequestStore,
} from "./requests.js";
import {
  DEEPSEEK_HARNESS_LEDGER_DOMAIN,
  openDeepSeekHarnessLedger,
  type DeepSeekHarnessLedger,
  type DeepSeekHarnessLedgerEntry,
} from "./ledger.js";
import {
  leaseSharedRequestStore,
  leaseSharedStore,
  type DeepSeekHarnessStoreLease,
} from "./shared-store.js";
import {
  DeepSeekHarnessSamplingLifecycle,
  type DeepSeekHarnessLifecycleReporter,
} from "./lifecycle.js";
import {
  type DeepSeekHarnessSourceBindings,
} from "./messages.js";
import {
  buildDeepSeekHarnessReplayPlan,
  recoverDeepSeekHarnessSession,
} from "./recovery.js";

export const name = "spine";
export const inject = [
  "agents",
  "llm",
  "sessions",
  "subagents",
  "tools",
  "storageDomain",
  "systemPrompt",
];

export interface Config {
  enabled?: boolean;
  configToml?: string;
  spawnProvider?: string;
  /** Contribute a read-only inspection to the Host Spine Tree broker (default true). */
  inspect?: boolean;
  /** Opt in to frozen request capture and the request-audit UI (default false). */
  requestAudit?: boolean;
  /** Captured requests retained per Session, oldest pruned first (default 100). */
  requestRetention?: number;
  /**
   * Agent preset id this row serves. The Host broker uses it to pick between
   * several Spine-enabled presets for a historical Session. Optional: a live
   * Session header supplies the same durable identity and outranks this seed.
   */
  presetId?: string;
}

interface DshAgent {
  readonly session: Session;
}

interface DshSubagentStartRequest {
  label: string;
  prompt: Array<{ type: "text"; text: string }>;
  parent: DshAgent;
  signal: AbortSignal;
  outputSchema: Record<string, unknown>;
}

interface DshSubagentRun {
  readonly id: string;
  readonly result: Promise<{
    structured?: unknown;
    stopReason: string;
  }>;
  dispose(): Promise<void>;
}

interface DshSubagents {
  start(provider: string, request: DshSubagentStartRequest): Promise<DshSubagentRun>;
}

interface SessionState {
  session: Session;
  lifecycle: DeepSeekHarnessSamplingLifecycle;
  runtime: NodeSpineRuntime;
  port: DeepSeekHarnessSpinePort;
  bindings: DeepSeekHarnessSourceBindings;
}

const MEMORY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["memory"],
  properties: {
    memory: { type: "string" },
  },
} as const;

/** Diagnostics identity for each mounted revision's broker contribution. */
let inspectionInstances = 0;

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return;
  assertExclusiveCompaction(ctx, "load");
  const spawnProvider = nonEmpty(config.spawnProvider ?? "spawn", "spawnProvider");
  const configToml = config.configToml;
  const contract = loadSpineContract(configToml);
  const states = new WeakMap<Session, Promise<SessionState>>();
  const resolvedStates = new WeakMap<Session, SessionState>();
  const bySessionId = new Map<string, Promise<SessionState>>();
  const liveStates = new Set<Promise<SessionState>>();
  let ledgerLease: DeepSeekHarnessStoreLease<DeepSeekHarnessLedger> | undefined;
  let requestLease: DeepSeekHarnessStoreLease<DeepSeekHarnessRequestStore> | undefined;

  const ledger = (): Promise<DeepSeekHarnessLedger> => {
    ledgerLease ??= leaseSharedStore(
      ctx.storageDomain,
      DEEPSEEK_HARNESS_LEDGER_DOMAIN,
      () => openDeepSeekHarnessLedger(ctx.storageDomain),
    );
    return ledgerLease.store;
  };

  const requestStore = (): Promise<DeepSeekHarnessRequestStore> => {
    requestLease ??= leaseSharedRequestStore(
      ctx.storageDomain,
      (retention) => openDeepSeekHarnessRequestStore(ctx.storageDomain, { retention }),
      config.requestRetention ?? DEFAULT_REQUEST_RETENTION,
    );
    return requestLease.store;
  };

  const inspection = config.inspect === false
    ? null
    : new DeepSeekHarnessInspection({
        ledger,
        requests: config.requestAudit === true ? requestStore : undefined,
        presetId: config.presetId,
        inspectSession: async (sessionId) => {
          const controller = (ctx as unknown as {
            get(name: string): unknown;
          }).get("sessionController") as {
            inspect(id: string): Promise<{
              meta: { createdAt: number };
              events: readonly SessionEvent[];
            }>;
          } | undefined;
          if (controller === undefined) return null;
          const found = await controller.inspect(sessionId);
          return { events: found.events, createdAt: found.meta.createdAt };
        },
        runtimeFactory: (thread) => createNodeSpineRuntime({
          thread,
          features: ["jit", "spawn"],
          ...(configToml === undefined ? {} : { configToml }),
        }),
      });
  if (inspection !== null) {
    inspection.start();
    // A preset plugin may not publish a service into the root realm: DSH
    // rejects that mount as a preset service leak. Contribute to the Host Web
    // companion's broker instead. The nested injection is optional by
    // construction, so a CLI/TUI composition without the Web companion never
    // waits for this service.
    const contribution: SpineInspectionContribution = {
      id: `spine-inspection-${++inspectionInstances}`,
      presetId: () => inspection.presetId(),
      hasLive: (sessionId) => inspection.hasLive(sessionId),
      owns: (sessionId) => inspection.owns(sessionId),
      view: (sessionId, request) => inspection.view(sessionId, request),
      request: (sessionId, requestId) => inspection.request(sessionId, requestId),
    };
    ctx.inject([SPINE_INSPECTION_HOST_SERVICE], (brokerCtx) => {
      const broker = (brokerCtx as unknown as {
        get(name: string): unknown;
      }).get(SPINE_INSPECTION_HOST_SERVICE) as SpineInspectionHost | undefined;
      if (broker === undefined) return;
      brokerCtx.effect(
        () => broker.register(contribution),
        "spine: Host inspection contribution",
      );
    });
  }

  const ensureState = (agent: DshAgent): Promise<SessionState> => {
    const existing = states.get(agent.session);
    if (existing !== undefined) return existing;
    const reporter = inspection === null
      ? undefined
      : inspectionReporter(inspection, agent.session);
    const recovering = recoverState(ctx, agent.session, configToml, ledger, reporter);
    states.set(agent.session, recovering);
    bySessionId.set(agent.session.id, recovering);
    liveStates.add(recovering);
    void recovering.then((state) => {
      resolvedStates.set(agent.session, state);
      inspection?.attach(agent.session);
    });
    void recovering.catch(() => {
      if (states.get(agent.session) === recovering) states.delete(agent.session);
      if (bySessionId.get(agent.session.id) === recovering) bySessionId.delete(agent.session.id);
      liveStates.delete(recovering);
    });
    return recovering;
  };

  const invalidateState = (session: Session): void => {
    const pending = states.get(session);
    states.delete(session);
    resolvedStates.delete(session);
    bySessionId.delete(session.id);
    if (pending !== undefined) {
      liveStates.delete(pending);
      void pending.then((state) => {
        state.lifecycle.dispose();
        state.runtime.dispose();
      }).catch(() => undefined);
    }
  };

  ctx.on("agent/pre-step", async (payload, next) => {
    const { agent } = payload as { agent: DshAgent };
    const state = await ensureState(agent);
    return preparePreStepDecision(
      state,
      next,
      () => invalidateState(agent.session),
    );
  }, { prepend: true });

  ctx.on("llm/stream", (request, next): AsyncIterable<StreamChunk> => {
    const sessionId = (request as { sessionId?: string; purpose?: string }).purpose === undefined
      ? (request as { sessionId?: string }).sessionId
      : undefined;
    const state = sessionId === undefined ? undefined : bySessionId.get(String(sessionId));
    if (state === undefined) return next();
    return beginThenStream(state, request, next, inspection);
  }, { prepend: true });

  ctx.on("session/event", (session, event) => {
    const resolved = resolvedStates.get(session);
    if (resolved !== undefined && isHostAcceptanceEvent(resolved.port, event)) {
      // Only a host-authored append proves acceptance; a plan copy written by
      // this adapter is derived output.
      resolved.lifecycle.noteLogged(String(event.data.id), event);
    }
    const pending = states.get(session);
    if (pending === undefined) return;
    void pending.then((state) => observeEvent(state, event)).catch(() => undefined);
  });

  ctx.on("agent/request-error", async (payload, next) => {
    const { agent, signal } = payload as { agent: DshAgent; signal: AbortSignal };
    const state = await ensureState(agent);
    await state.lifecycle.finishNow(signal.aborted ? "cancelled" : "failed");
    return next();
  }, { prepend: true });

  ctx.on("agent/turn-stopping", async (payload) => {
    const { agent } = payload as { agent: DshAgent };
    await (await ensureState(agent)).lifecycle.finishPendingSuccess();
  });

  ctx.on("session/disposed", (session) => {
    inspection?.detach(String(session.id));
    const pending = states.get(session);
    states.delete(session);
    resolvedStates.delete(session);
    bySessionId.delete(session.id);
    if (pending !== undefined) liveStates.delete(pending);
    if (pending !== undefined) {
      void pending.then(async (state) => {
        await state.lifecycle.drain().catch(() => undefined);
        state.lifecycle.dispose();
        state.runtime.dispose();
      }).catch(() => undefined);
    }
  });

  ctx.effect(() => async () => {
    const settled = await Promise.allSettled([...liveStates]);
    liveStates.clear();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      result.value.lifecycle.dispose();
      result.value.runtime.dispose();
    }
    await inspection?.close().catch(() => undefined);
    // Close only this instance's leases: another mounted preset revision may
    // still hold the same shared domain open.
    await Promise.allSettled([
      ledgerLease?.release(),
      requestLease?.release(),
    ]);
  }, "spine: dispose DSH session runtimes");

  // Core's workflow policy is model-facing only where the whole Spine tool
  // surface is visible in the assembling scope. A scoped section therefore
  // disappears with a restriction, a disabled preset, or plugin unload.
  ctx.systemPrompt.section({
    name: "tool:spine",
    order: ctx.systemPrompt.getSectionOrder("PLAN_POLICY") + 1,
    // Core's policy is literal model text, not a prompt-variable template.
    interpolate: false,
    text: ({ scope }) => SPINE_TOOL_NAMES.every((name) =>
      ctx.tools.get(name, scope) !== undefined)
      ? contract.rules
      : "",
  });

  for (const tool of contract.tools) {
    ctx.tools.register(
      createTool(ctx, tool, spawnProvider, ensureState) as unknown as ToolDefinition,
    );
  }
}

export async function recoverState(
  ctx: Context,
  session: Session,
  configToml: string | undefined,
  ledger: () => Promise<DeepSeekHarnessLedger>,
  reporter?: DeepSeekHarnessLifecycleReporter,
): Promise<SessionState> {
  let runtime: NodeSpineRuntime | undefined;
  let port: DeepSeekHarnessSpinePort | undefined;
  try {
    const replayCut = session.seq;
    const events = session.snapshotEvents();
    const ledgerInstance = await ledger();
    await inheritForkLedger(session, ledgerInstance);
    const entries = await ledgerInstance.entries(session.id, session.header.createdAt);
    const plan = buildDeepSeekHarnessReplayPlan(session.id, events, entries);
    const recovered = await recoverDeepSeekHarnessSession({
      plan,
      runtimeFactory(thread) {
        runtime = createNodeSpineRuntime({
          thread,
          features: ["jit", "spawn"],
          ...(configToml === undefined ? {} : { configToml }),
        });
        return runtime.client;
      },
      adapterFactory: async (client, bindings) => {
        port = createDeepSeekHarnessSessionPort({
          session,
          sessions: ctx.sessions,
          ledger: ledgerInstance,
          bindings,
          claimOwnership: async () => {
            assertExclusiveCompaction(ctx, "session recovery");
          },
        });
        const adapter = await createDeepSeekHarnessSpineAdapter({
          enabled: true,
          runtime: client,
          host: port,
        });
        if (adapter === null) throw new Error("Spine adapter unexpectedly disabled");
        return adapter;
      },
    });
    if (runtime === undefined || port === undefined) {
      throw new Error("DSH Spine recovery did not construct its runtime port");
    }
    // The recovered cursor is the authority for legal transitions before the
    // first pre-step preview runs.
    const recoveredContext = await recovered.adapter.preview();
    const lifecycle = new DeepSeekHarnessSamplingLifecycle(
      recovered.adapter,
      recovered.bindings,
      recovered.source,
      {
        replayCut,
        activeDepth: recoveredContext.projection.cursor.length,
        isPublishedSeq: port.isPublishedSeq,
        ...(reporter === undefined ? {} : { reporter }),
      },
    );
    return { session, lifecycle, runtime, port, bindings: recovered.bindings };
  } catch (error) {
    runtime?.dispose();
    throw error;
  }
}

/** Whether this session event is host acceptance, not a derived plan copy. */
export function isHostAcceptanceEvent(
  port: DeepSeekHarnessSpinePort,
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "user/message" }> {
  return event.type === "user/message" &&
    !port.isPublishedSeq(event.seq) &&
    event.data.source.kind !== "spine-context";
}

/** One pre-step waterfall step: settle the previous plan, then project inputs. */
export type PreparedStepDecision =
  | { kind: "reject" }
  | {
      kind: "enter";
      messages: UserMessage[];
      startsRequestSeries?: true;
    };

export async function preparePreStepDecision(
  state: SessionState,
  next: () => Promise<PreparedStepDecision>,
  onInvalid?: () => Promise<void> | void,
): Promise<PreparedStepDecision> {
  try {
    await state.lifecycle.finishPendingSuccess();
    const decision = await next();
    if (decision.kind !== "enter" || decision.messages.length === 0) return decision;
    // The host may replace ids or content. Only the ACCEPTED decision is
    // admitted; the claimed payload is never substituted back. The input is
    // logged unchanged, so the human transcript keeps what the user typed.
    await prepareStepInput(state, decision.messages);
    return decision;
  } catch (error) {
    // A failed pre-admission candidate must not survive as a phantom source.
    await onInvalid?.();
    throw error;
  }
}

/**
 * Admit the pre-request input and validate the projected plan.
 *
 * The agent loop appends `decision.messages` only after `agent/pre-step` and
 * then freezes the request from the session surface. The input is admitted and
 * logged with its original content — the human transcript renders append-origin
 * events, so a user anchor must never enter them. The anchor reaches the model
 * through the next publication, which replaces the logged input's surface node
 * with the anchored copy; replacement copies are model-only and never touch the
 * transcript. Session format v4 admits coordinate-carrying publication events
 * only inside an open step, so the prior portion (and any divergent replay)
 * defers and converges at the next in-step publication.
 */
export async function prepareStepInput(
  state: SessionState,
  messages: readonly DeepSeekHarnessMessage[],
): Promise<void> {
  const admitted = await state.lifecycle.admitInput(messages);
  const preview = await state.lifecycle.preview();
  const plan = preview.contextPlan;
  if (plan === null) {
    throw new Error("Spine preview returned no ContextPlan before request assembly");
  }
  const created = admitted.filter(({ created: isNew }) => isNew);
  if (created.length === 0) return;
  const newKeys = new Set(created.map(({ sourceId }) => sourceKey(sourceId)));
  const firstInput = plan.cells.findIndex((cell) =>
    cell.type === "source" && newKeys.has(sourceKey(cell.source_id)));
  if (firstInput < 0) {
    throw new Error("Spine ContextPlan omitted the current DSH input");
  }
  if (plan.cells.slice(firstInput).some((cell) =>
    cell.type !== "source" || !newKeys.has(sourceKey(cell.source_id)))) {
    throw new Error(
      "Spine ContextPlan places derived context after the current input; it cannot be published before request assembly",
    );
  }

  await state.lifecycle.publish({
    ...preview,
    contextPlan: { ...plan, cells: plan.cells.slice(0, firstInput) },
  });
}

function sourceKey(id: EpochOrdinalId): string {
  return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}

/**
 * Copy the parent's durable spawn-terminal records that sit inside a forked
 * prefix into the child ledger, so the child no longer depends on the parent
 * ledger surviving.
 *
 * Sampling archives are deliberately NOT inherited: replaying a parent's
 * sampling identities into the forked namespace makes the runtime reject the
 * child's first sampling ("sampling identities belong to another thread or
 * epoch"). The child rebuilds its tree and sampling epochs from its own
 * replayed host events instead, which is the only inheritance the runtime
 * supports across a namespace fork.
 */
export async function inheritForkLedger(
  session: Session,
  ledger: DeepSeekHarnessLedger,
): Promise<void> {
  const parentId = session.header.parentSession;
  if (parentId === undefined || session.inheritedEventCount <= 0) return;
  const parent = await ledger.findSession(parentId);
  if (parent === undefined) return;
  const inherited = [...parent.entries]
    .sort((left, right) => left.ordinal - right.ordinal)
    .filter((entry): entry is Extract<DeepSeekHarnessLedgerEntry, { kind: "spawn-terminal" }> =>
      entry.kind === "spawn-terminal" && entry.anchorSeq <= session.inheritedEventCount);
  for (const entry of inherited) {
    await ledger.appendSpawnTerminal(
      session.id,
      session.header.createdAt,
      entry.anchorSeq,
      entry.batchId,
      entry.result,
    );
  }
}

async function* beginThenStream(
  state: Promise<SessionState>,
  request: unknown,
  next: () => AsyncIterable<StreamChunk>,
  inspection: DeepSeekHarnessInspection | null,
): AsyncIterable<StreamChunk> {
  const resolved = await state;
  if (!looksLikeLoopRequest(request, String(resolved.session.id))) {
    // `llm/stream` surrounds every model call, not only the loop's step
    // requests. A hand-built one-shot call — the auto-permit approval judge, a
    // search planner — borrows the Session id for routing but is not a step: it
    // reaches its provider untouched, without beginning, settling, auditing, or
    // faulting the main sampling transaction. The same classification gates
    // request capture, so evidence and sampling admission cannot disagree.
    yield* next();
    return;
  }
  if (inspection !== null) {
    // Capturing evidence is an observation: it must run before sampling starts,
    // it must never block the model call, and a failure is reported, not thrown.
    inspection.captureRequest(resolved.session, request, (plan, projection) =>
      materializeDeepSeekHarnessContext(
        { transactionId: null, contextPlan: plan, projection },
        resolved.bindings,
      ));
  }
  await resolved.lifecycle.beginSampling(request);
  yield* next();
}

function inspectionReporter(
  inspection: DeepSeekHarnessInspection,
  session: Session,
): DeepSeekHarnessLifecycleReporter {
  return {
    context: (context, phase) => inspection.reportContext(session, context, phase),
    activity: (sampling, label) => inspection.reportActivity(session, sampling, label),
    fault: (cause) => inspection.reportFault(session, cause),
  };
}

export function observeEvent(state: SessionState, event: SessionEvent): void {
  if (event.type.startsWith("compaction/")) {
    state.lifecycle.violate(new Error(
      `DSH native ${event.type} violates Spine compaction ownership; disable the native compaction plugins (compaction-basic, tool-result-pruner) in every preset of this profile — a Host-plane disable alone does not reach preset-mounted rows`,
    ));
    return;
  }
  switch (event.type) {
    case "user/message":
      state.lifecycle.enqueueMessage(event.data, event);
      return;
    case "assistant/message":
      state.lifecycle.enqueueMessage(
        event.data.message,
        event,
        inputTokens(event.data.usage),
      );
      return;
    case "tool/result": {
      const message: DeepSeekHarnessMessage = event.data.message;
      if (message.role !== "tool") {
        throw new Error("DSH tool/result carries a non-tool message");
      }
      state.lifecycle.enqueueToolFinish(String(message.toolCallId), message.isError !== true);
      state.lifecycle.enqueueMessage(message, event);
      return;
    }
    case "tool/call":
      state.lifecycle.enqueueToolStart({
        callId: event.data.callId,
        name: event.data.name,
        arguments: event.data.arguments,
      });
      return;
    case "tool/ptc-dispatch-start":
      state.lifecycle.enqueueToolStart({
        callId: event.data.subCallId,
        name: event.data.name,
        arguments: event.data.arguments,
      });
      return;
    case "tool/ptc-dispatch":
      state.lifecycle.enqueueToolFinish(event.data.subCallId, event.data.isError !== true);
      return;
    case "step/end":
      state.lifecycle.enqueueSuccessfulStepEnd();
      return;
    case "turn/end": {
      const kind = event.data.reason.kind;
      if (kind === "aborted") state.lifecycle.enqueueFinish("cancelled");
      else if (kind === "error" || kind === "blocked") state.lifecycle.enqueueFinish("failed");
      return;
    }
    default:
      return;
  }
}

export function createTool(
  ctx: Context,
  tool: SpineToolContract,
  spawnProvider: string,
  ensureState: (agent: DshAgent) => Promise<SessionState>,
): ToolDefinition {
  const toolName = tool.name;
  const isSpawn = toolName === "spine_spawn";
  return {
    name: toolName,
    description: tool.description,
    parameters: tool.parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string" } },
      },
      render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const agent = exec.agent as unknown as DshAgent | undefined;
      if (agent === undefined) throw new Error(`${toolName} requires an owning DSH agent`);
      if (!isSpawn) {
        operationFromSpineToolCall(
          toolName as Exclude<SpineToolName, "spine_spawn">,
          args as Record<string, unknown>,
        );
        const state = await ensureState(agent);
        // Surface an illegal state transition as this call's error instead of
        // accepting it and faulting when the sampling commits.
        await state.lifecycle.beginToolExecution(
          exec.callId,
          toolName as Exclude<SpineToolName, "spine_spawn">,
          args,
        );
        return { status: "accepted" };
      }
      const tasks = decodeSpawnTasksOrExplain(args);
      const state = await ensureState(agent);
      await state.lifecycle.beginToolExecution(exec.callId, "spine_spawn", args);
      const results = await executeSpawnBatch({
        batchId: exec.callId,
        tasks,
        signal: exec.signal,
        staging: createDeepSeekHarnessSpawnStagingStore(state.port),
        executor: {
          execute: (task, child) => executeChild(ctx, spawnProvider, agent, task, child.signal),
        },
      });
      await state.lifecycle.stageSpawn(exec.callId, tasks, results);
      return { status: "accepted" };
    },
  } as unknown as ToolDefinition;
}

async function executeChild(
  ctx: Context,
  provider: string,
  parent: DshAgent,
  task: SpawnTask,
  signal: AbortSignal,
): Promise<SpawnChildTerminal> {
  const subagents = (ctx as Context & { subagents: DshSubagents }).subagents;
  const run = await subagents.start(provider, {
    label: task.summary,
    prompt: [{ type: "text", text: task.prompt }],
    parent,
    signal,
    outputSchema: MEMORY_OUTPUT_SCHEMA,
  });
  try {
    const result = await run.result;
    const memory = structuredMemory(result.structured);
    const outcome = result.stopReason === "completed"
      ? "completed"
      : result.stopReason === "aborted" ? "aborted" : "errored";
    return {
      outcome,
      memoryBody: memory,
      executionRef: String(run.id),
      ...(outcome === "completed" ? {} : { diagnostic: `DSH child stopped: ${result.stopReason}` }),
    };
  } finally {
    await run.dispose();
  }
}

/** Same core validation as the lifecycle path, but the model sees a message it can act on. */
function decodeSpawnTasksOrExplain(args: unknown): SpawnTask[] {
  try {
    return decodeSpineSpawnTasks(args as Record<string, unknown>);
  } catch (cause) {
    if (cause instanceof SpineToolInputError) {
      throw new SpineToolInputError(
        `${cause.message}. spine_spawn fans out independent work: pass at least two tasks; handle single-subtask work inline instead.`,
      );
    }
    throw cause;
  }
}

function inputTokens(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const fields = [value.inputTokens, value.cacheReadTokens, value.cacheWriteTokens];
  if (fields.some((field) => field !== undefined && (!Number.isSafeInteger(field) || Number(field) < 0))) {
    throw new Error("DSH assistant usage contains an invalid input token count");
  }
  if (fields.every((field) => field === undefined)) return undefined;
  return fields.reduce<number>((sum, field) => sum + (typeof field === "number" ? field : 0), 0);
}

function structuredMemory(value: unknown): string {
  if (!isRecord(value) || typeof value.memory !== "string" || value.memory.trim().length === 0) {
    throw new Error("DSH Spine child returned no structured model-authored memory");
  }
  return value.memory;
}

function nonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`Spine ${field} must not be empty`);
  return value;
}

function assertExclusiveCompaction(ctx: Context, stage: string): void {
  const compaction = getService(ctx, "compaction");
  if (compaction !== undefined) {
    throw new Error(
      `Spine publishes its own model context (${stage}); remove the DSH native compaction provider from the Spine-enabled composition`,
    );
  }
}

function getService(ctx: Context, name: string): unknown {
  return (ctx as Context & { get(name: string): unknown }).get(name);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
