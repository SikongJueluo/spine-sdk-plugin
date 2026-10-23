import type {
  ReplayItem,
  SourceSnapshot,
  SpineRuntimeClient,
} from "@spinejit/spine-sdk";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

import type { SpineHostAdapter } from "../host-adapter.js";
import {
  isDeepSeekHarnessMessageEvent,
  isSpineContextMessage,
  messageFromEvent,
} from "./dsh.js";
import {
  DEEPSEEK_HARNESS_ADAPTER_ID,
  type DeepSeekHarnessArchiveEvent,
} from "./index.js";
import {
  DeepSeekHarnessSourceBindings,
  observeDeepSeekHarnessMessage,
  type DeepSeekHarnessSourceObservation,
} from "./messages.js";
import type { DeepSeekHarnessLedgerEntry } from "./ledger.js";

export interface DeepSeekHarnessReplayPlan {
  runtimeThread: string;
  currentSessionId: string;
  inputs: ReplayItem[];
  sources: Array<{ boundary: number; observation: DeepSeekHarnessSourceObservation }>;
}

export interface RecoverDeepSeekHarnessSessionOptions {
  plan: DeepSeekHarnessReplayPlan;
  runtimeFactory(thread: string): SpineRuntimeClient;
  adapterFactory(
    runtime: SpineRuntimeClient,
    bindings: DeepSeekHarnessSourceBindings,
  ): Promise<SpineHostAdapter>;
}

export interface RecoveredDeepSeekHarnessSession {
  adapter: SpineHostAdapter;
  bindings: DeepSeekHarnessSourceBindings;
  source: SourceSnapshot;
}

export class DeepSeekHarnessRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepSeekHarnessRecoveryError";
  }
}

/**
 * Rebuild the Spine canonical replay from the real host log plus the private
 * ledger.
 *
 * Only host-authored messages are sources. Published projection copies repeat
 * an existing message identity, and derived Spine messages carry the
 * `spine-context` source kind, so both are skipped: replay never re-admits
 * output as new input. Ledger records carry the session sequence at which they
 * became durable, which restores their position among the source events.
 */
export function buildDeepSeekHarnessReplayPlan(
  currentSessionId: string,
  events: readonly SessionEvent[],
  ledger: readonly DeepSeekHarnessLedgerEntry[] = [],
): DeepSeekHarnessReplayPlan {
  type Operation =
    | { position: number; tie: number; item: ReplayItem; source: null }
    | { position: number; tie: number; item: ReplayItem; source: { boundary: number; observation: DeepSeekHarnessSourceObservation } };

  const operations: Operation[] = [];
  let firstArchiveThread: string | null = null;
  let boundary = 0;
  const seen = new Set<string>();

  for (const entry of ledger) {
    if (entry.kind !== "archive") continue;
    const archive = entry.archive as DeepSeekHarnessArchiveEvent;
    validateArchive(archive);
    firstArchiveThread ??= archive.record.record.attempt_id.thread;
    operations.push({
      position: entry.anchorSeq * 2,
      tie: entry.ordinal,
      item: { type: "archive", record: archive.record },
      source: null,
    });
  }

  for (const event of events) {
    if (event.type.startsWith("compaction/")) {
      throw new DeepSeekHarnessRecoveryError(
        `DSH native compaction event ${event.type} violates Spine compaction ownership`,
      );
    }
    if (!isDeepSeekHarnessMessageEvent(event)) continue;
    if (event.type === "system/message" || event.type === "developer/message") continue;
    const message = messageFromEvent(event);
    if (isSpineContextMessage(message)) continue;
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const observation = observeDeepSeekHarnessMessage(message, boundary, event);
    operations.push({
      position: event.seq * 2 + 1,
      tie: 0,
      item: { type: "source", character: observation.character },
      source: { boundary, observation },
    });
    boundary += 1;
  }

  operations.sort((left, right) =>
    left.position - right.position || left.tie - right.tie);
  return {
    runtimeThread: firstArchiveThread ?? currentSessionId,
    currentSessionId,
    inputs: operations.map((operation) => operation.item),
    sources: operations
      .filter((operation): operation is Extract<Operation, { source: { boundary: number } }> =>
        operation.source !== null)
      .map((operation) => operation.source),
  };
}

export async function recoverDeepSeekHarnessSession(
  options: RecoverDeepSeekHarnessSessionOptions,
): Promise<RecoveredDeepSeekHarnessSession> {
  const bindings = new DeepSeekHarnessSourceBindings();
  const runtime = options.runtimeFactory(options.plan.runtimeThread);
  const adapter = await options.adapterFactory(runtime, bindings);
  try {
    let source: SourceSnapshot | null = null;
    await adapter.replayWithSources(options.plan.inputs, async (snapshot) => {
      installDeepSeekHarnessSourceBindings(bindings, snapshot, options.plan.sources);
      source = snapshot;
    });
    if (options.plan.runtimeThread !== options.plan.currentSessionId) {
      source = await adapter.continueNamespace(options.plan.currentSessionId);
      installDeepSeekHarnessSourceBindings(bindings, source, options.plan.sources);
      await adapter.previewAndPublish();
    }
    if (source === null) {
      throw new DeepSeekHarnessRecoveryError("DSH Spine replay returned no source snapshot");
    }
    return { adapter, bindings, source };
  } catch (cause) {
    try {
      adapter.dispose();
    } catch (disposeCause) {
      throw new AggregateError(
        [cause, disposeCause],
        "DSH Spine recovery failed and adapter cleanup failed",
      );
    }
    throw cause;
  }
}

export function installDeepSeekHarnessSourceBindings(
  bindings: DeepSeekHarnessSourceBindings,
  source: SourceSnapshot,
  observations: readonly { boundary: number; observation: DeepSeekHarnessSourceObservation }[],
): void {
  if (source.cells.length !== observations.length) {
    throw new DeepSeekHarnessRecoveryError(
      `Spine source snapshot has ${source.cells.length} cells for ${observations.length} DSH messages`,
    );
  }
  const byBoundary = new Map(observations.map((item) => [item.boundary, item.observation]));
  if (byBoundary.size !== observations.length) {
    throw new DeepSeekHarnessRecoveryError("DSH replay has duplicate source boundaries");
  }
  bindings.clear();
  for (const cell of source.cells) {
    const observation = byBoundary.get(cell.boundary);
    if (observation === undefined) {
      throw new DeepSeekHarnessRecoveryError(
        `Spine source cell ${cell.source_id.ordinal} has unknown boundary ${cell.boundary}`,
      );
    }
    bindings.bind(cell.source_id, {
      message: observation.message,
      origin: observation.origin,
    });
  }
}

function validateArchive(archive: DeepSeekHarnessArchiveEvent): void {
  if (
    archive === null ||
    typeof archive !== "object" ||
    archive.schema !== DEEPSEEK_HARNESS_ADAPTER_ID ||
    typeof archive.durabilityId !== "string" ||
    archive.durabilityId.length === 0 ||
    archive.record === null ||
    typeof archive.record !== "object" ||
    archive.record.record === null ||
    typeof archive.record.record !== "object"
  ) {
    throw new DeepSeekHarnessRecoveryError("DSH Spine archive is malformed");
  }
  const record = archive.record.record;
  if (
    archive.record.type !== "sampling_started" &&
    archive.record.type !== "sampling_commit"
  ) {
    throw new DeepSeekHarnessRecoveryError("DSH Spine archive type is unknown");
  }
  if (
    typeof record.attempt_id !== "object" ||
    record.attempt_id === null ||
    typeof (record.attempt_id as { thread?: unknown }).thread !== "string" ||
    ((record.attempt_id as { thread: string }).thread).length === 0
  ) {
    throw new DeepSeekHarnessRecoveryError("DSH Spine archive identity is inconsistent");
  }
}
