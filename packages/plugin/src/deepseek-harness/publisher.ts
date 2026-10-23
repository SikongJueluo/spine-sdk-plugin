import type { Session, SessionEvent, SessionSeq, SessionStore } from "@deepseek-ai/dsh-session";

import {
  SPINE_CONTEXT_SOURCE_KIND,
  SPINE_INPUT_SOURCE_FIELD,
  type DeepSeekHarnessMessage,
  type DeepSeekHarnessMessageEvent,
} from "./dsh.js";

export class DeepSeekHarnessDurabilityError extends Error {
  constructor() {
    super("DeepSeek Harness has no session durability listener for the Spine session");
    this.name = "DeepSeekHarnessDurabilityError";
  }
}

/**
 * Publish one Spine ContextPlan through DSH's native surface protocol.
 *
 * DSH has no whole-context event. A context is the ordered `surface.nodes`
 * fold, and the public way to change it is a message event carrying
 * `surfaceOp: { op: 'replace', startSeq, endSeq }`. This publisher therefore:
 *
 * 1. keeps the protected system head and the longest content-equal prefix;
 * 2. replaces the divergent surface tail with one empty `developer/message`
 *    carrier (empty developer messages derive no model-visible message);
 * 3. appends the planned messages, preserving each original message identity
 *    and its durable assistant/tool event payload.
 *
 * Unchanged plans are a no-op, so a normal step never copies history.
 */
export class DeepSeekHarnessSurfacePublisher {
  readonly #session: Session;
  readonly #sessions: SessionStore;
  readonly #origin: (messageId: string) => DeepSeekHarnessMessageEvent | null;
  readonly #ownSeqs = new Set<number>();

  constructor(
    session: Session,
    sessions: SessionStore,
    origin: (messageId: string) => DeepSeekHarnessMessageEvent | null,
  ) {
    this.#session = session;
    this.#sessions = sessions;
    this.#origin = origin;
  }

  /** True when this adapter appended the event; such events are derived output. */
  isOwnSeq(seq: number): boolean {
    return this.#ownSeqs.has(seq);
  }

  async publish(messages: readonly DeepSeekHarnessMessage[]): Promise<number> {
    const session = this.#session;
    const nodes = [...session.surface.nodes];
    const events = new Map<number, SessionEvent>(
      session.snapshotEvents().map((event) => [event.seq, event]),
    );

    const position = currentPosition(events.values());
    if (messages.length === 0) {
      const visible = nodes.some((node) => {
        const event = events.get(node);
        if (event === undefined) return false;
        return event.type !== "system/message" && session.deriveEventMessage(event) !== null;
      });
      if (visible) {
        throw new Error(
          "Spine context plan is empty while DSH holds model-visible history; refusing to erase it",
        );
      }
    }

    let keep = 0;
    const head = nodes[0];
    if (head !== undefined && events.get(head)?.type === "system/message") keep = 1;
    let next = 0;
    while (keep < nodes.length && next < messages.length) {
      const node = nodes[keep]!;
      const event = events.get(node);
      if (event === undefined) {
        throw new Error(`DSH surface node ${node} has no session event`);
      }
      const derived = session.deriveEventMessage(event);
      if (derived === null) {
        keep += 1;
        continue;
      }
      if (!sameMessage(derived, messages[next]!)) break;
      keep += 1;
      next += 1;
    }
    while (keep < nodes.length) {
      const node = nodes[keep]!;
      const event = events.get(node);
      if (event !== undefined && session.deriveEventMessage(event) === null) {
        keep += 1;
        continue;
      }
      break;
    }
    if (keep === nodes.length && next === messages.length) return 0;

    const toolCalls = new Set<string>();
    for (let index = 0; index < next; index += 1) collectToolCalls(messages[index]!, toolCalls);

    // Keep the longest content-equal suffix too: a compaction summary can then
    // replace the old range in one native replacement and leave the recent
    // assistant/tool nodes (which cannot be replacement carriers) untouched.
    let suffixNodes = 0;
    let suffixMessages = 0;
    while (
      nodes.length - 1 - suffixNodes >= keep &&
      messages.length - 1 - suffixMessages >= next
    ) {
      const node = nodes[nodes.length - 1 - suffixNodes]!;
      const event = events.get(node);
      const derived = event === undefined ? null : session.deriveEventMessage(event);
      if (derived === null) {
        // Invisible carriers consume a surface node, never a planned message.
        suffixNodes += 1;
        continue;
      }
      if (!sameMessage(derived, messages[messages.length - 1 - suffixMessages]!)) break;
      suffixNodes += 1;
      suffixMessages += 1;
    }

    const middleNodes = nodes.slice(keep, nodes.length - suffixNodes);
    const middleMessages = messages.slice(next, messages.length - suffixMessages);
    let appended = 0;

    if (middleMessages.length === 0) {
      if (middleNodes.length > 0) {
        this.#ownSeqs.add(this.#replaceWithCarrier(middleNodes, position).seq);
        appended += 1;
      }
    } else if (
      middleNodes.length > 0 &&
      middleMessages.length === 1 &&
      isReplacementCarrier(middleMessages[0]!)
    ) {
      this.#ownSeqs.add(this.#replaceMessage(middleNodes, middleMessages[0]!, position).seq);
      appended += 1;
    } else {
      const replaced = nodes.slice(keep);
      if (replaced.length > 0) {
        this.#ownSeqs.add(this.#replaceWithCarrier(replaced, position).seq);
        appended += 1;
      }
      for (let index = next; index < messages.length; index += 1) {
        const message = messages[index]!;
        if (message.role === "tool" && !toolCalls.has(String(message.toolCallId))) {
          throw new Error(
            `Spine context plan publishes tool result ${String(message.toolCallId)} without its assistant tool call`,
          );
        }
        this.#ownSeqs.add(this.#appendMessage(message, position).seq);
        collectToolCalls(message, toolCalls);
        appended += 1;
      }
    }

    if (!await this.#sessions.flush(session)) {
      throw new DeepSeekHarnessDurabilityError();
    }
    return appended;
  }

  #replaceWithCarrier(
    nodes: readonly SessionSeq[],
    position: TurnStepPosition,
  ): SessionEvent {
    const carrier = {
      id: `spine:carrier:${this.#session.id}:${this.#session.seq}`,
      role: "developer",
      content: [],
      source: { kind: SPINE_CONTEXT_SOURCE_KIND, form: "recall" },
    } as unknown as Extract<DeepSeekHarnessMessage, { role: "developer" }>;
    return this.#session.append(
      "developer/message",
      { turn: position.turn, step: position.step, message: carrier },
      {
        surfaceOp: {
          op: "replace",
          startSeq: nodes[0]!,
          endSeq: nodes[nodes.length - 1]!,
        },
        sourceEventSeqs: [...nodes],
      },
    );
  }

  #replaceMessage(
    nodes: readonly SessionSeq[],
    message: DeepSeekHarnessMessage,
    position: TurnStepPosition,
  ): SessionEvent {
    const surfaceOp = {
      op: "replace" as const,
      startSeq: nodes[0]!,
      endSeq: nodes[nodes.length - 1]!,
    };
    const sourceEventSeqs = [...nodes];
    switch (message.role) {
      case "user":
        this.#assertAcceptedInput(message);
        return this.#session.append("user/message", message, { surfaceOp, sourceEventSeqs });
      case "developer": {
        const origin = this.#origin(message.id);
        return this.#session.append("developer/message", {
          turn: origin?.type === "developer/message" ? origin.data.turn : position.turn,
          step: origin?.type === "developer/message" ? origin.data.step : position.step,
          message,
          ...(origin?.type === "developer/message" && origin.data.headerSeq !== undefined
            ? { headerSeq: origin.data.headerSeq }
            : {}),
        }, { surfaceOp, sourceEventSeqs });
      }
      case "system": {
        const origin = this.#origin(message.id);
        return this.#session.append("system/message", {
          turn: origin?.type === "system/message" ? origin.data.turn : position.turn,
          step: origin?.type === "system/message" ? origin.data.step : position.step,
          message,
        }, { surfaceOp, sourceEventSeqs });
      }
      case "assistant":
      case "tool":
        throw new Error(`DSH cannot replace a surface range with a ${message.role} message`);
    }
  }

  #appendMessage(message: DeepSeekHarnessMessage, position: TurnStepPosition): SessionEvent {
    const session = this.#session;
    switch (message.role) {
      case "user":
        this.#assertAcceptedInput(message);
        return session.append("user/message", message, { surfaceOp: "append" });
      case "developer": {
        const origin = this.#origin(message.id);
        return session.append("developer/message", {
          turn: origin?.type === "developer/message" ? origin.data.turn : position.turn,
          step: origin?.type === "developer/message" ? origin.data.step : position.step,
          message,
          ...(origin?.type === "developer/message" && origin.data.headerSeq !== undefined
            ? { headerSeq: origin.data.headerSeq }
            : {}),
        }, { surfaceOp: "append" });
      }
      case "system": {
        const origin = this.#origin(message.id);
        return session.append("system/message", {
          turn: origin?.type === "system/message" ? origin.data.turn : position.turn,
          step: origin?.type === "system/message" ? origin.data.step : position.step,
          message,
        }, { surfaceOp: "append" });
      }
      case "assistant": {
        const origin = this.#requireOrigin(message.id, "assistant/message");
        return session.append("assistant/message", {
          turn: origin.data.turn,
          step: origin.data.step,
          message,
          stream: origin.data.stream,
          ...(origin.data.usage === undefined ? {} : { usage: origin.data.usage }),
          ...(origin.data.interrupted === undefined ? {} : { interrupted: origin.data.interrupted }),
        }, { surfaceOp: "append" });
      }
      case "tool": {
        const origin = this.#requireOrigin(message.id, "tool/result");
        return session.append("tool/result", {
          turn: origin.data.turn,
          step: origin.data.step,
          message,
          ...(origin.data.error === undefined ? {} : { error: origin.data.error }),
          ...(origin.data.meta === undefined ? {} : { meta: origin.data.meta }),
        }, { surfaceOp: "append" });
      }
    }
  }

  #assertAcceptedInput(message: DeepSeekHarnessMessage): void {
    if (message.source.kind === SPINE_CONTEXT_SOURCE_KIND) return;
    if (this.#origin(message.id) === null) {
      throw new Error(
        `DSH has no accepted host event for Spine input ${message.id}; refusing to publish it`,
      );
    }
  }

  #requireOrigin(
    messageId: string,
    type: "assistant/message",
  ): Extract<SessionEvent, { type: "assistant/message" }>;
  #requireOrigin(
    messageId: string,
    type: "tool/result",
  ): Extract<SessionEvent, { type: "tool/result" }>;
  #requireOrigin(
    messageId: string,
    type: "assistant/message" | "tool/result",
  ): Extract<SessionEvent, { type: "assistant/message" | "tool/result" }> {
    const origin = this.#origin(messageId);
    if (origin === null || origin.type !== type) {
      throw new Error(`DSH has no durable ${type} origin for Spine projection message ${messageId}`);
    }
    return origin as Extract<SessionEvent, { type: "assistant/message" | "tool/result" }>;
  }
}

/** The turn/step coordinates a synthetic event is admitted at. */
interface TurnStepPosition {
  turn: number;
  step: number;
}

/**
 * DSH session format v4 admits a `developer/message` only at a positive turn
 * and step, and the persistence worker rejects the flush otherwise. Spine
 * publishes between host steps, so synthetic events borrow the session's open
 * turn and its latest started step; a log without turn markers (fresh or
 * seeded before the first turn) falls back to the first position.
 */
function currentPosition(events: Iterable<SessionEvent>): TurnStepPosition {
  let turn = 0;
  let step = 0;
  for (const event of events) {
    if (event.type === "turn/start") {
      turn = event.data.turn;
      step = 0;
    } else if (event.type === "step/start" && event.data.turn === turn) {
      step = Math.max(step, event.data.step);
    }
  }
  return { turn: Math.max(turn, 1), step: Math.max(step, 1) };
}

/** Stable structural comparison of two persisted messages. */
export function sameMessage(
  left: DeepSeekHarnessMessage,
  right: DeepSeekHarnessMessage,
): boolean {
  return stableStringify(comparableMessage(left)) === stableStringify(comparableMessage(right));
}

function comparableMessage(message: DeepSeekHarnessMessage): unknown {
  const source = { ...message.source } as Record<string, unknown>;
  delete source[SPINE_INPUT_SOURCE_FIELD];
  return { ...message, source };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isReplacementCarrier(message: DeepSeekHarnessMessage): boolean {
  return message.role === "user" || message.role === "developer" || message.role === "system";
}

function collectToolCalls(
  message: DeepSeekHarnessMessage,
  calls: Set<string>,
): void {
  for (const block of message.content) {
    if (block.type === "tool-call" && typeof block.id === "string") calls.add(block.id);
  }
}
