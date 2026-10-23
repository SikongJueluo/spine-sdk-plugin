import type {
  EpochOrdinalId,
  SourceSnapshot,
  SpawnResult,
  SpawnTask,
  Terminal,
} from "@spinejit/spine-sdk";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

import type { PublishedContext } from "../controller.js";
import type { SpineHostAdapter } from "../host-adapter.js";
import {
  decodeSpineSpawnTasks,
  isSpineToolName,
  operationFromSpineToolCall,
  SpineToolInputError,
} from "../tools.js";
import type { DeepSeekHarnessMessage, DeepSeekHarnessMessageEvent } from "./dsh.js";
import {
  DeepSeekHarnessSourceBindings,
  observeDeepSeekHarnessMessage,
} from "./messages.js";

export interface DeepSeekHarnessToolStart {
  callId: string;
  name: string;
  arguments: unknown;
}

export class DeepSeekHarnessLifecycleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepSeekHarnessLifecycleError";
  }
}

/** Owns one DSH step-to-Spine sampling transaction at a time. */
export class DeepSeekHarnessSamplingLifecycle {
  readonly #adapter: SpineHostAdapter;
  readonly #bindings: DeepSeekHarnessSourceBindings;
  readonly #isPublishedSeq: (seq: number) => boolean;
  readonly #executions = new Set<string>();
  /** Every message identity admitted so far, including inputs admitted before logging. */
  readonly #admitted = new Map<string, EpochOrdinalId>();
  readonly #preAdmitted = new Set<string>();
  readonly #logged = new Set<string>();
  #nextBoundary: number;
  #replayCut: number;
  #samplingActive = false;
  #successfulStepPending = false;
  #inputTokens: number | undefined;
  #fault: unknown = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    adapter: SpineHostAdapter,
    bindings: DeepSeekHarnessSourceBindings,
    source: SourceSnapshot,
    options: {
      /** Events below this sequence were already replayed from the host log. */
      replayCut?: number;
      /** Predicate marking events the adapter itself published. */
      isPublishedSeq?: (seq: number) => boolean;
    } = {},
  ) {
    this.#adapter = adapter;
    this.#bindings = bindings;
    this.#nextBoundary = nextSourceBoundary(source);
    this.#replayCut = options.replayCut ?? 0;
    this.#isPublishedSeq = options.isPublishedSeq ?? (() => false);
  }

  get fault(): unknown {
    return this.#fault ?? this.#adapter.fault;
  }

  enqueueMessage(
    message: DeepSeekHarnessMessage,
    origin: DeepSeekHarnessMessageEvent | null,
    inputTokens?: number,
  ): void {
    if (origin !== null && (origin.seq < this.#replayCut || this.#isPublishedSeq(origin.seq))) {
      return;
    }
    if (this.#admitted.has(message.id)) {
      // The pre-step admitted this input before the loop appended it. The host
      // event is the acceptance evidence the publisher requires.
      if (origin !== null) this.#bindings.setOrigin(message.id, origin);
      this.#logged.add(message.id);
      return;
    }
    this.#enqueue(async () => {
      const observation = observeDeepSeekHarnessMessage(message, this.#nextBoundary, origin);
      const admitted = await this.#adapter.observeSources([observation.character]);
      const sourceId = admitted[0];
      if (admitted.length !== 1 || sourceId === undefined) {
        throw new DeepSeekHarnessLifecycleError(
          `Spine admitted ${admitted.length} source IDs for one DSH message`,
        );
      }
      this.#bindings.bind(sourceId, {
        message: observation.message,
        origin: observation.origin,
      });
      this.#admitted.set(message.id, sourceId);
      this.#nextBoundary += 1;
      if (inputTokens !== undefined) this.#inputTokens = inputTokens;
    });
  }

  /**
   * Admit the step's claimed user messages before the agent loop appends them,
   * so a ContextPlan can be published before request assembly.
   */
  admitInput(
    messages: readonly DeepSeekHarnessMessage[],
  ): Promise<Array<{ messageId: string; sourceId: EpochOrdinalId; created: boolean }>> {
    return this.#serialize(async () => {
      this.#assertHealthy();
      const admitted: Array<{ messageId: string; sourceId: EpochOrdinalId; created: boolean }> = [];
      for (const message of messages) {
        const existing = this.#admitted.get(message.id);
        if (existing !== undefined) {
          admitted.push({ messageId: message.id, sourceId: existing, created: false });
          continue;
        }
        const observation = observeDeepSeekHarnessMessage(message, this.#nextBoundary, null);
        const sourceIds = await this.#adapter.observeSources([observation.character]);
        const sourceId = sourceIds[0];
        if (sourceIds.length !== 1 || sourceId === undefined) {
          throw new DeepSeekHarnessLifecycleError(
            `Spine admitted ${sourceIds.length} source IDs for one DSH input`,
          );
        }
        this.#bindings.bind(sourceId, {
          message: observation.message,
          origin: null,
        });
        this.#admitted.set(message.id, sourceId);
        this.#preAdmitted.add(message.id);
        this.#nextBoundary += 1;
        admitted.push({ messageId: message.id, sourceId, created: true });
      }
      return admitted;
    });
  }

  /** Synchronously record that a pre-admitted input's durable event arrived. */
  noteLogged(messageId: string, origin?: DeepSeekHarnessMessageEvent): void {
    if (!this.#preAdmitted.has(messageId)) return;
    this.#logged.add(messageId);
    if (origin !== undefined) this.#bindings.setOrigin(messageId, origin);
  }

  preview(): Promise<PublishedContext> {
    return this.#serialize(() => this.#adapter.preview());
  }

  publish(context: PublishedContext): Promise<void> {
    return this.#serialize(() => this.#adapter.publish(context));
  }

  enqueueToolStart(start: DeepSeekHarnessToolStart): boolean {
    if (!isSpineToolName(start.name)) return false;
    const toolName = start.name;
    this.#enqueue(async () => {
      this.#assertSamplingActive();
      if (this.#executions.has(start.callId)) {
        throw new DeepSeekHarnessLifecycleError(`duplicate DSH Spine tool call ${start.callId}`);
      }
      // Model-authored arguments are rejected, not faulted: the tool's own
      // execute() surfaces the identical validation failure to the model as
      // an erroneous tool result it may retry inside the same sampling. The
      // call stays unregistered, so tool finish is a no-op.
      try {
        const input = decodeToolInput(start.arguments);
        const operation = toolName === "spine_spawn"
          ? null
          : operationFromSpineToolCall(toolName, input);
        if (toolName === "spine_spawn") decodeSpineSpawnTasks(input);
        await this.#adapter.registerExecution(start.callId);
        this.#executions.add(start.callId);
        if (operation !== null) {
          await this.#adapter.stageExecution(
            start.callId,
            start.callId,
            operation,
          );
        }
      } catch (cause) {
        if (!(cause instanceof SpineToolInputError)) throw cause;
      }
    });
    return true;
  }

  enqueueToolFinish(callId: string, succeeded: boolean): boolean {
    this.#enqueue(async () => {
      if (!this.#executions.has(callId)) return;
      await this.#adapter.finishExecution(callId, succeeded);
      this.#executions.delete(callId);
    });
    return true;
  }

  stageSpawn(
    callId: string,
    tasks: readonly SpawnTask[],
    results: readonly SpawnResult[],
  ): Promise<void> {
    return this.#serialize(async () => {
      this.#assertSamplingActive();
      if (!this.#executions.has(callId)) {
        throw new DeepSeekHarnessLifecycleError(`unknown DSH Spine Spawn call ${callId}`);
      }
      await this.#adapter.stageExecution(callId, callId, {
        type: "spawn",
        tasks: [...tasks],
        terminal_results: [...results],
      });
    });
  }

  async beginSampling(_request?: unknown): Promise<void> {
    await this.drain();
    await this.#serialize(async () => {
      this.#assertInputsLogged();
      if (this.#samplingActive) {
        throw new DeepSeekHarnessLifecycleError("DSH began a request before the prior step ended");
      }
      await this.#adapter.beginSampling();
      this.#samplingActive = true;
      this.#inputTokens = undefined;
      this.#successfulStepPending = false;
      this.#executions.clear();
    });
  }

  enqueueSuccessfulStepEnd(): void {
    this.#enqueue(async () => {
      if (this.#samplingActive) this.#successfulStepPending = true;
    });
  }

  async finishPendingSuccess(): Promise<void> {
    await this.drain();
    await this.#serialize(async () => {
      if (this.#successfulStepPending) await this.#finish("completed");
    });
  }

  enqueueFinish(terminal: Terminal): void {
    this.#enqueue(async () => {
      this.#successfulStepPending = false;
      await this.#finish(terminal);
    });
  }

  violate(cause: unknown): void {
    this.#enqueue(() => Promise.reject(cause));
  }

  async finishNow(terminal: Terminal): Promise<void> {
    await this.drain();
    await this.#serialize(async () => {
      this.#successfulStepPending = false;
      await this.#finish(terminal);
    });
  }

  async drain(): Promise<void> {
    await this.#tail;
    this.#assertHealthy();
  }

  dispose(): void {
    this.#adapter.dispose();
  }

  async #finish(terminal: Terminal): Promise<void> {
    // A pre-admitted input that never reached the log poisons the canonical
    // source order; fault even when no sampling started (e.g. cancellation
    // between pre-step and the user append).
    this.#assertInputsLogged();
    if (!this.#samplingActive) return;
    if (this.#executions.size !== 0) {
      throw new DeepSeekHarnessLifecycleError(
        `DSH sampling ended with unfinished Spine executions: ${[...this.#executions].join(", ")}`,
      );
    }
    await this.#adapter.finishSampling(terminal, this.#inputTokens);
    this.#samplingActive = false;
    this.#successfulStepPending = false;
    this.#inputTokens = undefined;
  }

  #enqueue(operation: () => Promise<void>): void {
    this.#tail = this.#tail.then(() => this.#guard(operation));
    void this.#tail.catch(() => undefined);
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await this.#guard(operation);
    } finally {
      release();
    }
  }

  async #guard<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertHealthy();
    try {
      return await operation();
    } catch (cause) {
      this.#fault ??= cause;
      throw new DeepSeekHarnessLifecycleError("DSH Spine lifecycle fault", { cause });
    }
  }

  #assertHealthy(): void {
    if (this.fault !== null) {
      throw new DeepSeekHarnessLifecycleError("DSH Spine lifecycle is faulted", {
        cause: this.fault,
      });
    }
  }

  #assertInputsLogged(): void {
    const missing = [...this.#preAdmitted].filter((id) => !this.#logged.has(id));
    if (missing.length > 0) {
      throw new DeepSeekHarnessLifecycleError(
        `DSH pre-admitted input was never appended to the log: ${missing.join(", ")}`,
      );
    }
  }

  #assertSamplingActive(): void {
    if (!this.#samplingActive) {
      throw new DeepSeekHarnessLifecycleError("DSH Spine operation occurred outside sampling");
    }
  }
}

function decodeToolInput(input: unknown): Record<string, unknown> {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new SpineToolInputError("DSH Spine tool arguments are not JSON");
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpineToolInputError("DSH Spine tool arguments are not an object");
  }
  return value as Record<string, unknown>;
}

function nextSourceBoundary(source: SourceSnapshot): number {
  return source.cells.reduce((next, cell) => Math.max(next, cell.boundary + 1), 0);
}

/** Narrow a session event to the message event that produced it. */
export function messageEventOf(
  event: SessionEvent,
): DeepSeekHarnessMessageEvent | null {
  switch (event.type) {
    case "user/message":
    case "assistant/message":
    case "tool/result":
      return event;
    default:
      return null;
  }
}
