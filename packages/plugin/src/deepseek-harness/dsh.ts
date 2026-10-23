/**
 * Real DeepSeek Harness contracts used by the Spine adapter.
 *
 * The adapter used to carry hand-written `Session`, `Message`, and `SessionStore`
 * shapes. Those were not the host contract: they claimed an `events` property
 * and a required-event-owner registry that DSH never provided. Everything here
 * is imported from the pinned `@deepseek-ai` packages (type-only at runtime) so a
 * host upgrade fails the build instead of silently drifting.
 *
 * @module @deepseek-ai/dsh-session adapter types
 */
import type { ContentBlock, ContextFormed, Message } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

/**
 * Producer-owned source kind for messages the Spine adapter itself writes.
 *
 * DSH retired the shared `{ kind: 'plugin' }` wrapper; downstream producers
 * declare their own kind by module augmentation. `form: 'recall'` is the
 * documented semantic form for material lifted out of another history.
 */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "spine-context": {
      kind: "spine-context";
    } & ContextFormed;
  }
}

export const SPINE_CONTEXT_SOURCE_KIND = "spine-context" as const;

/** Source field carrying the pre-anchor input content the model was admitted with. */
export const SPINE_INPUT_SOURCE_FIELD = "spineInput" as const;

/**
 * Provenance for a user message whose logged content carries a Spine user
 * anchor. Spine observed the original content; recovery must observe that same
 * content instead of treating the presentation anchor as user text.
 */
export interface DeepSeekHarnessInputProvenance {
  readonly content: readonly ContentBlock[];
  /** The producer-owned source the host accepted, without this provenance field. */
  readonly source: DeepSeekHarnessMessage["source"];
}

/** One model-visible DSH message, exactly as the host persists it. */
export type DeepSeekHarnessMessage = Message;

/** Surface event types that carry a persisted message. */
export type DeepSeekHarnessMessageEvent = Extract<
  SessionEvent,
  {
    type:
      | "system/message"
      | "developer/message"
      | "user/message"
      | "assistant/message"
      | "tool/result";
  }
>;

/** The live host session this adapter is attached to. */
export type DeepSeekHarnessSession = Session;

/** True for a session event whose payload is a model-visible surface message. */
export function isDeepSeekHarnessMessageEvent(
  event: SessionEvent,
): event is DeepSeekHarnessMessageEvent {
  switch (event.type) {
    case "system/message":
    case "developer/message":
    case "user/message":
    case "assistant/message":
    case "tool/result":
      return true;
    default:
      return false;
  }
}

/** Extract the persisted message from a surface event, if it carries one. */
export function messageFromEvent(
  event: DeepSeekHarnessMessageEvent,
): DeepSeekHarnessMessage {
  switch (event.type) {
    case "user/message":
      return event.data;
    case "system/message":
    case "developer/message":
    case "assistant/message":
    case "tool/result":
      return event.data.message;
  }
}

/** Whether one message was produced by this adapter rather than the host. */
export function isSpineContextMessage(message: DeepSeekHarnessMessage): boolean {
  return (message.source as { kind?: unknown }).kind === SPINE_CONTEXT_SOURCE_KIND;
}

/** Attach the original input content without changing the model-facing content. */
export function withInputProvenance(
  message: DeepSeekHarnessMessage,
  original: DeepSeekHarnessMessage,
): DeepSeekHarnessMessage {
  const source = { ...original.source } as Record<string, unknown>;
  delete source[SPINE_INPUT_SOURCE_FIELD];
  return {
    ...message,
    source: {
      ...message.source,
      [SPINE_INPUT_SOURCE_FIELD]: {
        content: original.content,
        source,
      },
    },
  } as unknown as DeepSeekHarnessMessage;
}

/** Recover the pre-anchor content of a user message logged by this adapter. */
export function originalInputMessage(
  message: DeepSeekHarnessMessage,
): DeepSeekHarnessMessage | null {
  const provenance = (message.source as Record<string, unknown>)[SPINE_INPUT_SOURCE_FIELD];
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    !Array.isArray((provenance as { content?: unknown }).content)
  ) return null;
  const stored = provenance as {
    content: readonly ContentBlock[];
    source?: unknown;
  };
  return {
    ...message,
    content: stored.content,
    source: stored.source !== null && typeof stored.source === "object"
      ? stored.source
      : { kind: "user" },
  } as unknown as DeepSeekHarnessMessage;
}
