/**
 * Read-only reconstruction of a historical Session's Spine tree.
 *
 * A Session that is not live still has two canonical inputs: the Host event log
 * and the plugin-owned ledger. `buildDeepSeekHarnessReplayPlan` already merges
 * them for recovery; this module runs that plan in an isolated, disposable
 * runtime with no archive writer and no surface publisher, so inspection can
 * never publish context, wake an Agent, or append durable state.
 */
import type {
  ReplayItem,
  SpineProjection,
  SpineRuntimeClient,
} from "@spinejit/spine-sdk";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

import { createSpineController } from "../controller.js";
import type { DeepSeekHarnessLedger, DeepSeekHarnessLedgerEntry } from "./ledger.js";
import { buildDeepSeekHarnessReplayPlan } from "./recovery.js";

export interface HistoricalSpineTree {
  projection: SpineProjection | null;
  entries: readonly DeepSeekHarnessLedgerEntry[];
  /** Why no projection is available; null when reconstruction succeeded. */
  reason: string | null;
  thread: string | null;
  epoch: number | null;
}

export interface DisposableSpineRuntime {
  client: SpineRuntimeClient;
  dispose(): void;
}

export interface ReconstructSpineTreeInput {
  sessionId: string;
  sessionCreatedAt: number;
  events: readonly SessionEvent[];
  ledger: () => Promise<DeepSeekHarnessLedger>;
  runtimeFactory: (thread: string) => DisposableSpineRuntime;
}

export async function reconstructSpineTree(
  input: ReconstructSpineTreeInput,
): Promise<HistoricalSpineTree> {
  let entries: readonly DeepSeekHarnessLedgerEntry[];
  try {
    entries = await (await input.ledger()).entries(input.sessionId, input.sessionCreatedAt);
  } catch (error) {
    return {
      projection: null,
      entries: [],
      reason: `Spine ledger is unreadable: ${messageOf(error)}`,
      thread: null,
      epoch: null,
    };
  }
  if (!entries.some((entry) => entry.kind === "archive")) {
    return {
      projection: null,
      entries,
      reason: "This Session has no Spine sampling archive yet; there is no committed tree to replay.",
      thread: null,
      epoch: null,
    };
  }

  let runtime: DisposableSpineRuntime | undefined;
  try {
    const plan = buildDeepSeekHarnessReplayPlan(input.sessionId, input.events, entries);
    runtime = input.runtimeFactory(plan.runtimeThread);
    const controller = createSpineController({
      enabled: true,
      runtime: runtime.client,
      archive: { persist: async () => undefined },
      context: { publish: async () => undefined },
    });
    if (controller === null) throw new Error("Spine controller is disabled");
    const replayed = await controller.replay(plan.inputs as ReplayItem[]);
    let projection = replayed.projection;
    let epoch = replayed.contextPlan?.epoch ?? null;
    if (plan.runtimeThread !== input.sessionId) {
      await controller.continueNamespace(input.sessionId);
      const continued = await controller.preview();
      projection = continued.projection;
      epoch = continued.contextPlan?.epoch ?? epoch;
    }
    return {
      projection,
      entries,
      reason: null,
      thread: plan.runtimeThread,
      epoch,
    };
  } catch (error) {
    return {
      projection: null,
      entries,
      reason: `Spine replay failed: ${messageOf(error)}`,
      thread: null,
      epoch: null,
    };
  } finally {
    runtime?.dispose();
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
