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
  SPINE_TOOL_NAMES,
  type SpineToolName,
} from "../tools.js";
import {
  withInputProvenance,
  type DeepSeekHarnessMessage,
} from "./dsh.js";
import {
  createDeepSeekHarnessSessionPort,
  createDeepSeekHarnessSpawnStagingStore,
  createDeepSeekHarnessSpineAdapter,
  type DeepSeekHarnessSpinePort,
} from "./index.js";
import {
  openDeepSeekHarnessLedger,
  type DeepSeekHarnessLedger,
} from "./ledger.js";
import {
  DeepSeekHarnessSamplingLifecycle,
} from "./lifecycle.js";
import {
  materializeDeepSeekHarnessContext,
  type DeepSeekHarnessSourceBindings,
} from "./messages.js";
import {
  buildDeepSeekHarnessReplayPlan,
  recoverDeepSeekHarnessSession,
} from "./recovery.js";

export const name = "spine";
export const inject = ["agents", "llm", "sessions", "subagents", "tools", "storageDomain"];

export interface Config {
  enabled?: boolean;
  configToml?: string;
  spawnProvider?: string;
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

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return;
  assertExclusiveCompaction(ctx, "load");
  const spawnProvider = nonEmpty(config.spawnProvider ?? "spawn", "spawnProvider");
  const configToml = config.configToml;
  const states = new WeakMap<Session, Promise<SessionState>>();
  const resolvedStates = new WeakMap<Session, SessionState>();
  const bySessionId = new Map<string, Promise<SessionState>>();
  const liveStates = new Set<Promise<SessionState>>();
  let ledgerPromise: Promise<DeepSeekHarnessLedger> | undefined;

  const ledger = (): Promise<DeepSeekHarnessLedger> => {
    ledgerPromise ??= openDeepSeekHarnessLedger(ctx.storageDomain);
    return ledgerPromise;
  };

  const ensureState = (agent: DshAgent): Promise<SessionState> => {
    const existing = states.get(agent.session);
    if (existing !== undefined) return existing;
    const recovering = recoverState(ctx, agent.session, configToml, ledger);
    states.set(agent.session, recovering);
    bySessionId.set(agent.session.id, recovering);
    liveStates.add(recovering);
    void recovering.then((state) => resolvedStates.set(agent.session, state));
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
    return beginThenStream(state, request, next);
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
    if (ledgerPromise !== undefined) {
      await ledgerPromise.then((open) => open.close()).catch(() => undefined);
    }
  }, "spine: dispose DSH session runtimes");

  for (const toolName of SPINE_TOOL_NAMES) {
    ctx.tools.register(createTool(ctx, toolName, spawnProvider, ensureState) as unknown as ToolDefinition);
  }
}

export async function recoverState(
  ctx: Context,
  session: Session,
  configToml: string | undefined,
  ledger: () => Promise<DeepSeekHarnessLedger>,
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
    const lifecycle = new DeepSeekHarnessSamplingLifecycle(
      recovered.adapter,
      recovered.bindings,
      recovered.source,
      { replayCut, isPublishedSeq: port.isPublishedSeq },
    );
    return { lifecycle, runtime, port, bindings: recovered.bindings };
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
    // admitted and materialized; the claimed payload is not authoritative.
    const replacements = await prepareStepInput(state, decision.messages);
    return {
      ...decision,
      messages: decision.messages.map((message) =>
        replacements.get(message.id) ?? message),
    };
  } catch (error) {
    // A failed pre-admission candidate must not survive as a phantom source.
    await onInvalid?.();
    throw error;
  }
}

/**
 * Publish the pre-request portion of the plan and return the current inputs with
 * the Spine materialized content (for example a user anchor).
 *
 * The agent loop appends `decision.messages` only after `agent/pre-step` and then
 * freezes the request. Admitting the claimed input early lets this adapter apply
 * compaction and anchors before `buildRequest`, without rewriting the frozen
 * request at `llm/stream`.
 */
export async function prepareStepInput(
  state: SessionState,
  messages: readonly DeepSeekHarnessMessage[],
): Promise<Map<string, Extract<DeepSeekHarnessMessage, { role: "user" }>>> {
  const admitted = await state.lifecycle.admitInput(messages);
  const preview = await state.lifecycle.preview();
  const plan = preview.contextPlan;
  if (plan === null) {
    throw new Error("Spine preview returned no ContextPlan before request assembly");
  }
  const created = admitted.filter(({ created: isNew }) => isNew);
  if (created.length === 0) return new Map();
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

  const materialized = materializeDeepSeekHarnessContext(preview, state.bindings);
  const bySource = new Map<string, DeepSeekHarnessMessage>();
  plan.cells.forEach((cell, index) => {
    if (cell.type === "source" && newKeys.has(sourceKey(cell.source_id))) {
      const message = materialized[index];
      if (message !== undefined) bySource.set(sourceKey(cell.source_id), message);
    }
  });

  const byId = new Map(messages.map((message) => [String(message.id), message]));
  const replacements = new Map<string, Extract<DeepSeekHarnessMessage, { role: "user" }>>();
  for (const { messageId, sourceId } of admitted) {
    const target = bySource.get(sourceKey(sourceId));
    const original = byId.get(messageId);
    if (target === undefined || original === undefined || target.role !== "user") {
      throw new Error(`Spine ContextPlan has no materialized user input for ${messageId}`);
    }
    if (String(target.id) !== messageId) {
      throw new Error(`Spine ContextPlan changed the input identity ${messageId} to ${String(target.id)}`);
    }
    // Only human inputs receive a Spine UserAnchor; other legal user-role
    // producers (goal, agent message, auto-continue, runtime context) keep
    // their producer-owned source and content.
    replacements.set(
      messageId,
      target.source.kind === "user"
        ? withInputProvenance(target, original) as Extract<DeepSeekHarnessMessage, { role: "user" }>
        : target,
    );
  }
  return replacements;
}

function sourceKey(id: EpochOrdinalId): string {
  return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}

/**
 * Copy the parent's durable journals that are inside a forked prefix into the
 * child ledger. A child then no longer depends on the parent ledger surviving.
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
    .filter((entry) => entry.anchorSeq <= session.inheritedEventCount);
  for (const entry of inherited) {
    if (entry.kind === "archive") {
      await ledger.appendArchive(
        session.id,
        session.header.createdAt,
        entry.anchorSeq,
        entry.archive,
      );
    } else {
      await ledger.appendSpawnTerminal(
        session.id,
        session.header.createdAt,
        entry.anchorSeq,
        entry.batchId,
        entry.result,
      );
    }
  }
}

async function* beginThenStream(
  state: Promise<SessionState>,
  request: unknown,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  const resolved = await state;
  await resolved.lifecycle.beginSampling(request);
  yield* next();
}

export function observeEvent(state: SessionState, event: SessionEvent): void {
  if (event.type.startsWith("compaction/")) {
    state.lifecycle.violate(new Error(`DSH native ${event.type} violates Spine compaction ownership`));
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

function createTool(
  ctx: Context,
  toolName: SpineToolName,
  spawnProvider: string,
  ensureState: (agent: DshAgent) => Promise<SessionState>,
): ToolDefinition {
  const isSpawn = toolName === "spine_spawn";
  return {
    name: toolName,
    description: toolDescription(toolName),
    parameters: isSpawn
      ? {
          type: "object",
          additionalProperties: false,
          required: ["tasks"],
          properties: {
            tasks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["summary", "prompt"],
                properties: {
                  summary: { type: "string" },
                  prompt: { type: "string" },
                },
              },
            },
          },
        }
      : toolParameters(toolName),
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
        return { status: "accepted" };
      }
      const tasks = decodeSpineSpawnTasks(args as Record<string, unknown>);
      const state = await ensureState(agent);
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

function toolParameters(name: Exclude<SpineToolName, "spine_spawn">): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (name === "spine_open" || name === "spine_next") {
    properties.goal = { type: "string" };
    required.push("goal");
  }
  if (name === "spine_close" || name === "spine_next") {
    properties.memory = { type: "string" };
    required.push("memory");
  }
  return { type: "object", additionalProperties: false, required, properties };
}

function toolDescription(name: SpineToolName): string {
  switch (name) {
    case "spine_open": return "Open one child Spine scope with a concise summary.";
    case "spine_close": return "Close the active Spine scope with model-authored memory.";
    case "spine_next": return "Close the active Spine scope and open its next sibling.";
    case "spine_spawn": return "Run independent child tasks and return ordered terminal memories.";
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
