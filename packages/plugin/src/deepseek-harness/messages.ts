import type {
  ContextItem,
  ContextPlanCell,
  EpochOrdinalId,
  SourceCharacter,
} from "@spinejit/spine-sdk";

import type { PublishedContext } from "../controller.js";
import {
  SPINE_CONTEXT_SOURCE_KIND,
  originalInputMessage,
  withInputProvenance,
  type DeepSeekHarnessMessage,
  type DeepSeekHarnessMessageEvent,
} from "./dsh.js";

export type DeepSeekHarnessContentBlock = DeepSeekHarnessMessage["content"][number];

/** A host message plus the durable event it was first observed in. */
export interface DeepSeekHarnessSourceObservation {
  character: SourceCharacter;
  message: DeepSeekHarnessMessage;
  origin: DeepSeekHarnessMessageEvent | null;
}

export interface DeepSeekHarnessBoundSource {
  message: DeepSeekHarnessMessage;
  origin: DeepSeekHarnessMessageEvent | null;
}

export class DeepSeekHarnessContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekHarnessContextError";
  }
}

export class DeepSeekHarnessSourceBindings {
  readonly #messages = new Map<string, DeepSeekHarnessBoundSource>();
  readonly #origins = new Map<string, DeepSeekHarnessMessageEvent>();

  bind(sourceId: EpochOrdinalId, source: DeepSeekHarnessBoundSource): void {
    const key = sourceIdKey(sourceId);
    if (this.#messages.has(key)) {
      throw new DeepSeekHarnessContextError(`duplicate DSH source binding ${key}`);
    }
    this.#messages.set(key, {
      message: structuredClone(source.message),
      origin: source.origin === null ? null : structuredClone(source.origin),
    });
    if (source.origin !== null && !this.#origins.has(source.message.id)) {
      this.#origins.set(source.message.id, structuredClone(source.origin));
    }
  }

  resolve(sourceId: EpochOrdinalId): DeepSeekHarnessBoundSource {
    const source = this.#messages.get(sourceIdKey(sourceId));
    if (source === undefined) {
      throw new DeepSeekHarnessContextError(
        `missing DSH message for source ${sourceIdKey(sourceId)}`,
      );
    }
    return {
      message: structuredClone(source.message),
      origin: source.origin === null ? null : structuredClone(source.origin),
    };
  }

  /** The first durable host event that produced one message identity. */
  origin(messageId: string): DeepSeekHarnessMessageEvent | null {
    return this.#origins.get(messageId) ?? null;
  }

  /** Attach the host event for a pre-admitted message once the loop logs it. */
  setOrigin(messageId: string, origin: DeepSeekHarnessMessageEvent): void {
    if (this.#origins.has(messageId)) return;
    this.#origins.set(messageId, structuredClone(origin));
  }

  clear(): void {
    this.#messages.clear();
    this.#origins.clear();
  }
}

/**
 * Map one host message to the portable source vocabulary.
 *
 * DSH tool results are top-level `role: 'tool'` messages with their own
 * `toolCallId`/`isError` fields; they are not user messages carrying a
 * `tool-result` block. They stay opaque to Spine, exactly like Pi tool results.
 */
export function observeDeepSeekHarnessMessage(
  message: DeepSeekHarnessMessage,
  boundary: number,
  origin: DeepSeekHarnessMessageEvent | null = null,
): DeepSeekHarnessSourceObservation {
  const observed = originalInputMessage(message) ?? message;
  if (observed.role === "tool") {
    return { character: { type: "opaque", boundary }, message: observed, origin };
  }
  return {
    character: {
      type: "message",
      boundary,
      role: sourceRole(observed),
      content: stableJson(observed),
    },
    message: observed,
    origin,
  };
}

export function materializeDeepSeekHarnessContext(
  context: PublishedContext,
  bindings: DeepSeekHarnessSourceBindings,
): DeepSeekHarnessMessage[] {
  if (context.contextPlan === null) return [];
  return context.contextPlan.cells.map((cell) => {
    if (cell.type === "projection") return materializeProjection(cell);
    const bound = bindings.resolve(cell.source_id);
    let message = bound.message;
    for (const label of cell.labels) {
      message = prependUserAnchor(message, label.UserAnchor);
    }
    if (cell.labels.length > 0 && message.role === "user" && message.source.kind === "user") {
      // The anchor is a presentation rewrite of a human input. Keep the
      // pre-anchor content so a logged replacement is replayable.
      message = withInputProvenance(message, bound.message);
    }
    return message;
  });
}

function materializeProjection(
  cell: Extract<ContextPlanCell, { type: "projection" }>,
): DeepSeekHarnessMessage {
  const item = cell.item;
  if ("SyntheticNode" in item) {
    const node = item.SyntheticNode;
    return syntheticMessage(
      cell,
      `<spine_node id="${node.node_id.join(".")}" summary="${escapeXmlAttribute(node.summary)}" status="${node.status.toLowerCase()}">\n</spine_node>`,
    );
  }
  if ("MemorySlot" in item && "Summary" in item.MemorySlot) {
    const memory = item.MemorySlot.Summary;
    return syntheticMessage(
      cell,
      `<spine_memory node_id="${memory.owner_node.join(".")}">\n${memory.body}\n</spine_memory>`,
    );
  }
  if ("MemorySlot" in item && "SpawnEvidence" in item.MemorySlot) {
    const evidence = item.MemorySlot.SpawnEvidence;
    return syntheticMessage(
      cell,
      `<spine_spawn_evidence node_id="${evidence.owner_node.join(".")}">\n${JSON.stringify({
        summary: evidence.task.summary,
        prompt: evidence.task.prompt,
        outcome: evidence.outcome,
        diagnostic: evidence.diagnostic,
        execution_ref: evidence.execution_ref,
      }, null, 2)}\n</spine_spawn_evidence>`,
    );
  }
  throw unsupportedProjection(item);
}

function syntheticMessage(
  cell: Extract<ContextPlanCell, { type: "projection" }>,
  text: string,
): DeepSeekHarnessMessage {
  return {
    id: `spine:${cell.projection_id.thread}:${cell.projection_id.epoch}:${cell.projection_id.ordinal}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: SPINE_CONTEXT_SOURCE_KIND, form: "recall" },
  } as unknown as DeepSeekHarnessMessage;
}

function prependUserAnchor(
  message: DeepSeekHarnessMessage,
  anchor: number,
): DeepSeekHarnessMessage {
  if (message.role !== "user") {
    throw new DeepSeekHarnessContextError(
      `Spine user anchor U${anchor} targets a non-user DSH message`,
    );
  }
  // Producer-owned user-role context (goal, agent-message, runtime context)
  // stays contextual_user; only a human prompt receives the anchor.
  if (message.source.kind !== "user") return message;
  const copy = structuredClone(message);
  const content = [...copy.content];
  const firstText = content.findIndex((block) => block.type === "text");
  if (firstText < 0) {
    content.unshift({ type: "text", text: `[U${anchor}]\n` });
  } else {
    const block = content[firstText] as { type: string; text?: unknown };
    if (typeof block.text !== "string") {
      throw new DeepSeekHarnessContextError(`DSH text block for U${anchor} has no text`);
    }
    content[firstText] = { type: "text", text: `[U${anchor}]\n${block.text}` };
  }
  return { ...copy, content };
}

function sourceRole(
  message: DeepSeekHarnessMessage,
): "user" | "contextual_user" | "assistant" | "system" | "developer" {
  if (message.role === "assistant") return "assistant";
  if (message.role === "system") return "system";
  if (message.role === "developer") return "developer";
  if (message.source.kind === "user") return "user";
  return "contextual_user";
}

function unsupportedProjection(item: ContextItem): DeepSeekHarnessContextError {
  return new DeepSeekHarnessContextError(
    `DSH cannot materialize Spine projection item ${Object.keys(item)[0] ?? "unknown"}`,
  );
}

function sourceIdKey(id: EpochOrdinalId): string {
  return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
