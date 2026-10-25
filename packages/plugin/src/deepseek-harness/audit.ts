/**
 * Deterministic comparison between a Spine ContextPlan and the frozen request
 * DSH assembled for the same step.
 *
 * The comparison answers a narrow question: did the messages Spine planned reach
 * the assembled request, in order, once each, with the expected role and
 * content? It does not and cannot judge whether a memory summary is semantically
 * complete. Everything it cannot attribute is reported as a difference instead
 * of being normalized away.
 */
import { createHash } from "node:crypto";

import type { ContextPlanRecipe } from "@spinejit/spine-sdk";

import type { SpineAuditStatus } from "./view.js";

export type SpineDifferenceCategory =
  | "missing-plan-message"
  | "unexpected-request-message"
  | "content-changed"
  | "order"
  | "duplicate"
  | "anchor-presentation"
  | "host-layer"
  | "truncated"
  | "plan-unavailable"
  | "plan-unmaterializable";

export interface SpineAuditMessage {
  index: number;
  role: string;
  sourceKind: string;
  messageId: string | null;
  digest: string;
  chars: number;
  preview: string;
}

export interface SpineAuditDifference {
  category: SpineDifferenceCategory;
  detail: string;
  planIndex: number | null;
  requestIndex: number | null;
  expected: string | null;
  actual: string | null;
}

export interface SpinePlanCellAudit {
  index: number;
  type: "source" | "projection";
  label: string;
  expected: SpineAuditMessage | null;
  matchedRequestIndex: number | null;
  /** Why no expected fingerprint is available for this cell. */
  note: string | null;
}

export interface SpineAuditHostLayer {
  leadingSystem: boolean;
  systemMessages: number;
  developerMessages: number;
  systemText: boolean;
  toolCount: number;
  toolNames: string[];
}

export interface SpineAuditResult {
  status: SpineAuditStatus;
  planCells: SpinePlanCellAudit[];
  spineMessages: SpineAuditMessage[];
  hostLayer: SpineAuditHostLayer;
  expectedCount: number;
  actualCount: number;
  matchedCount: number;
  differences: SpineAuditDifference[];
  notes: string[];
}

export interface AuditInput {
  /** The plan captured for this exact request, or null when none was recorded. */
  plan: ContextPlanRecipe | null;
  /** Plan cells materialized into model messages; null when materialization failed. */
  expected: readonly unknown[] | null;
  /** The frozen request messages. */
  actual: readonly unknown[];
  /** One-shot system prompt carried beside the message list. */
  system?: string | undefined;
  /** The captured body exceeded the storage cap. */
  truncated?: boolean;
  /** Materialization failure text, when `expected` is null. */
  planError?: string | null;
  /** Tool declarations on the same request; host-owned, recorded not judged. */
  tools?: readonly unknown[] | undefined;
}

const UNEXPLAINED = new Set<SpineDifferenceCategory>([
  "missing-plan-message",
  "unexpected-request-message",
  "content-changed",
  "order",
  "duplicate",
  "plan-unmaterializable",
  "truncated",
  "plan-unavailable",
]);

const ANCHOR = /^\[U(\d+)\]\n/;

export function auditRequest(input: AuditInput): SpineAuditResult {
  const notes: string[] = [];
  const differences: SpineAuditDifference[] = [];
  const hostLayer = describeHostLayer(input.actual, input.system, input.tools);
  const planCells = describePlanCells(input.plan, input.expected);

  const actualAll = input.actual.map((value, index) => ({ index, message: normalizeMessage(value) }));
  const spineEntries = actualAll.filter((entry) =>
    entry.message.role !== "system" && entry.message.role !== "developer");
  const spineIndexes = spineEntries.map((entry) => entry.index);
  const originalIndex = (spineIndex: number): number => spineIndexes[spineIndex] ?? spineIndex;

  if (input.truncated === true) {
    notes.push("Captured request exceeded the storage cap; the comparison is not authoritative.");
    differences.push({
      category: "truncated",
      detail: "Request body was truncated before storage.",
      planIndex: null,
      requestIndex: null,
      expected: null,
      actual: null,
    });
  }
  if (input.plan === null) {
    notes.push("No ContextPlan was recorded for this request; nothing can be compared.");
    differences.push({
      category: "plan-unavailable",
      detail: "The request has no associated Spine plan.",
      planIndex: null,
      requestIndex: null,
      expected: null,
      actual: null,
    });
    return {
      status: "insufficient",
      planCells,
      spineMessages: describeEntries(spineEntries),
      hostLayer,
      expectedCount: 0,
      actualCount: spineEntries.length,
      matchedCount: 0,
      differences,
      notes,
    };
  }
  if (input.expected === null) {
    const detail = input.planError ?? "The plan could not be materialized into model messages.";
    notes.push(detail);
    differences.push({
      category: "plan-unmaterializable",
      detail,
      planIndex: null,
      requestIndex: null,
      expected: null,
      actual: null,
    });
    return {
      status: "insufficient",
      planCells,
      spineMessages: describeEntries(spineEntries),
      hostLayer,
      expectedCount: planCells.length,
      actualCount: spineEntries.length,
      matchedCount: 0,
      differences,
      notes,
    };
  }

  const expected = input.expected.map(normalizeMessage);
  const actual = spineEntries.map((entry) => entry.message);
  const pairs = alignMessages(expected, actual);

  const matchedRequest = new Map<number, number>();
  for (const pair of pairs.matched) {
    matchedRequest.set(pair.planIndex, pair.requestIndex);
  }

  for (const pair of pairs.reordered) {
    matchedRequest.set(pair.planIndex, pair.requestIndex);
  }

  for (const pair of pairs.rewritten) {
    matchedRequest.set(pair.planIndex, pair.requestIndex);
    const known = pair.category === "anchor-presentation";
    differences.push({
      category: pair.category,
      detail: known
        ? "The same message identity reached the request with a Spine user anchor prefix."
        : "The same message identity reached the request with different content.",
      planIndex: pair.planIndex,
      requestIndex: originalIndex(pair.requestIndex),
      expected: expected[pair.planIndex]?.preview ?? null,
      actual: actual[pair.requestIndex]?.preview ?? null,
    });
  }

  const orderPairs = [...pairs.matched, ...pairs.reordered, ...pairs.rewritten]
    .sort((left, right) => left.planIndex - right.planIndex);
  let previousRequestIndex = -1;
  for (const pair of orderPairs) {
    if (pair.requestIndex <= previousRequestIndex) {
      // Covers plain reordering and rewritten messages (anchor or content)
      // that still land in the wrong position; the digest-keyed alignment
      // cannot see either by itself.
      differences.push({
        category: "order",
        detail: "The message reaches the request before a message the plan places earlier.",
        planIndex: pair.planIndex,
        requestIndex: originalIndex(pair.requestIndex),
        expected: expected[pair.planIndex]?.preview ?? null,
        actual: actual[pair.requestIndex]?.preview ?? null,
      });
    }
    previousRequestIndex = pair.requestIndex;
  }

  for (const planIndex of pairs.missing) {
    differences.push({
      category: "missing-plan-message",
      detail: "A message planned for this request is absent from the assembled request.",
      planIndex,
      requestIndex: null,
      expected: expected[planIndex]?.preview ?? null,
      actual: null,
    });
  }
  for (const requestIndex of pairs.unexpected) {
    const message = actual[requestIndex];
    differences.push({
      category: "unexpected-request-message",
      detail: `The assembled request carries a message the plan does not attribute (${describeOrigin(message)}).`,
      planIndex: null,
      requestIndex: originalIndex(requestIndex),
      expected: null,
      actual: message?.preview ?? null,
    });
  }
  for (const duplicate of pairs.duplicates) {
    differences.push({
      category: "duplicate",
      detail: `The request repeats a message the plan contains ${duplicate.expected} time(s) (${duplicate.role}).`,
      planIndex: null,
      requestIndex: originalIndex(duplicate.requestIndex),
      expected: null,
      actual: duplicate.preview,
    });
  }

  for (const cell of planCells) {
    if (cell.expected === null) continue;
    const matchedIndex = matchedRequest.get(cell.index);
    cell.matchedRequestIndex = matchedIndex === undefined ? null : originalIndex(matchedIndex);
  }

  const unexplained = differences.filter((difference) => UNEXPLAINED.has(difference.category));
  const known = differences.filter((difference) => !UNEXPLAINED.has(difference.category));
  const status: SpineAuditStatus = input.truncated === true
    ? "insufficient"
    : unexplained.length > 0
      ? "unexplained"
      : known.length > 0 ? "known-differences" : "consistent";

  if (hostLayer.leadingSystem) {
    notes.push("The leading system-role message is the DSH system prompt; Spine does not plan it.");
  }
  if (hostLayer.developerMessages > 0) {
    notes.push(`${hostLayer.developerMessages} developer message(s) are host-owned context, not Spine plan cells.`);
  }
  if (hostLayer.systemText) {
    notes.push("A one-shot system prompt travels beside the message list; it is host-owned.");
  }
  if (hostLayer.toolCount > 0) {
    notes.push(`${hostLayer.toolCount} tool declaration(s) are host-owned and are not part of the Spine plan.`);
  }

  return {
    status,
    planCells,
    spineMessages: describeEntries(spineEntries),
    hostLayer,
    expectedCount: expected.length,
    actualCount: actual.length,
    matchedCount: pairs.matched.length + pairs.reordered.length + pairs.rewritten.length,
    differences,
    notes,
  };
}

interface NormalizedMessage {
  role: string;
  sourceKind: string;
  messageId: string | null;
  parts: unknown[];
  texts: string[];
  digest: string;
  preview: string;
  chars: number;
}

function normalizeMessage(value: unknown): NormalizedMessage {
  const message = isRecord(value) ? value : {};
  const role = typeof message.role === "string" ? message.role : "unknown";
  const sourceKind = isRecord(message.source) && typeof message.source.kind === "string"
    ? message.source.kind
    : "none";
  const messageId = typeof message.id === "string" ? message.id : null;
  const parts: unknown[] = [];
  const texts: string[] = [];
  const content = message.content;
  if (typeof content === "string") {
    parts.push({ type: "text", text: content });
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
        texts.push(block.text);
      } else {
        parts.push(block);
      }
    }
  } else if (content !== undefined) {
    parts.push(content);
  }
  if (typeof message.toolCallId === "string") {
    parts.push({ type: "tool-call-ref", id: message.toolCallId });
  }
  if (message.isError === true) {
    parts.push({ type: "error" });
  }
  return {
    role,
    sourceKind,
    messageId,
    parts,
    texts,
    digest: digestParts(role, parts),
    preview: previewOf(parts),
    chars: parts.reduce<number>((total, part) => total + JSON.stringify(part ?? null).length, 0),
  };
}

function digestParts(role: string, parts: readonly unknown[]): string {
  const body = parts.map((part) => JSON.stringify(part ?? null)).join("\u0001");
  return createHash("sha256").update(`${role}\u0000${body}`, "utf8").digest("hex");
}

interface AnchorInfo {
  /** Only a human user prompt may carry a Spine anchor. */
  eligible: boolean;
  /** Present only when this message actually carries a `[Un]` prefix. */
  anchor: number | null;
  /** Digest with the anchor prefix removed; equal to `digest` when unanchored. */
  strippedDigest: string;
}

function anchorInfo(message: NormalizedMessage): AnchorInfo {
  const eligible = message.role === "user" && message.sourceKind === "user";
  const base: AnchorInfo = { eligible, anchor: null, strippedDigest: message.digest };
  if (!eligible || message.texts.length === 0) return base;
  const first = message.texts[0] ?? "";
  const match = ANCHOR.exec(first);
  if (match === null) return base;
  const stripped = first.slice(match[0].length);
  let replaced = false;
  const parts = message.parts.map((part) => {
    if (replaced || !isRecord(part) || part.type !== "text") return part;
    replaced = true;
    return { type: "text", text: stripped };
  });
  return {
    eligible,
    anchor: Number(match[1]),
    strippedDigest: digestParts(message.role, parts),
  };
}

function previewOf(parts: readonly unknown[]): string {
  const text: string[] = [];
  for (const part of parts) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      text.push(part.text);
    } else if (isRecord(part) && typeof part.type === "string") {
      text.push(`[${part.type}]`);
    }
  }
  const collapsed = text.join(" ").replace(/\s+/g, " ").trim();
  return collapsed.length > 180 ? `${collapsed.slice(0, 180)}…` : collapsed;
}

interface AlignmentPair {
  planIndex: number;
  requestIndex: number;
}

interface Alignment {
  matched: AlignmentPair[];
  /** Same message, same content, different position than the plan places it. */
  reordered: AlignmentPair[];
  rewritten: Array<AlignmentPair & { category: "anchor-presentation" | "content-changed" }>;
  missing: number[];
  unexpected: number[];
  duplicates: Array<{ requestIndex: number; role: string; preview: string; expected: number }>;
}

function alignMessages(
  expected: readonly NormalizedMessage[],
  actual: readonly NormalizedMessage[],
): Alignment {
  const matched: AlignmentPair[] = [];
  const matchedExpected = new Set<number>();
  const matchedActual = new Set<number>();

  const keysExpected = expected.map((message) => `${message.role}\u0000${message.digest}`);
  const keysActual = actual.map((message) => `${message.role}\u0000${message.digest}`);
  for (const pair of longestCommonSubsequence(keysExpected, keysActual)) {
    matched.push(pair);
    matchedExpected.add(pair.planIndex);
    matchedActual.add(pair.requestIndex);
  }

  const reordered: AlignmentPair[] = [];
  const rewritten: Alignment["rewritten"] = [];
  for (let planIndex = 0; planIndex < expected.length; planIndex += 1) {
    if (matchedExpected.has(planIndex)) continue;
    const planMessage = expected[planIndex];
    if (planMessage === undefined || planMessage.messageId === null) continue;
    for (let requestIndex = 0; requestIndex < actual.length; requestIndex += 1) {
      if (matchedActual.has(requestIndex)) continue;
      const requestMessage = actual[requestIndex];
      if (requestMessage === undefined || requestMessage.messageId !== planMessage.messageId) continue;
      matchedExpected.add(planIndex);
      matchedActual.add(requestIndex);
      const category = classifySameIdentity(planMessage, requestMessage);
      if (category === "order") reordered.push({ planIndex, requestIndex });
      else rewritten.push({ planIndex, requestIndex, category });
      break;
    }
  }

  const missing: number[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    if (!matchedExpected.has(index)) missing.push(index);
  }
  const unexpected: number[] = [];
  for (let index = 0; index < actual.length; index += 1) {
    if (!matchedActual.has(index)) unexpected.push(index);
  }

  const duplicates: Alignment["duplicates"] = [];
  const expectedCounts = new Map<string, number>();
  for (const key of keysExpected) expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  const rewrittenActual = new Set(rewritten.map((pair) => pair.requestIndex));
  const seen = new Map<string, number>();
  for (let index = 0; index < actual.length; index += 1) {
    if (rewrittenActual.has(index)) continue;
    const key = keysActual[index] ?? "";
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    const allowed = expectedCounts.get(key) ?? 0;
    if (count > allowed) {
      const message = actual[index];
      duplicates.push({
        requestIndex: index,
        role: message?.role ?? "unknown",
        preview: message?.preview ?? "",
        expected: allowed,
      });
    }
  }

  return { matched, reordered, rewritten, missing, unexpected, duplicates };
}

/**
 * Classify one same-identity pair the ordered alignment left unmatched.
 *
 * Equal digests mean the message is the same content at the wrong position, so
 * the only defensible finding is an order anomaly. An anchor exception requires
 * concrete anchor evidence on a human user prompt:
 *
 * - at least one side carries a `[Un]` prefix whose removal reproduces the
 *   other side's digest, and
 * - when both sides are anchored, the anchor numbers must be identical.
 *
 * A missing prefix is the documented presentation difference (`U1` added by a
 * later publication). A changed number is a different anchor identity, and a
 * prefix on a non-user or non-human message is not a Spine anchor at all; both
 * are content errors, never known differences.
 */
function classifySameIdentity(
  planMessage: NormalizedMessage,
  requestMessage: NormalizedMessage,
): "order" | "anchor-presentation" | "content-changed" {
  if (planMessage.digest === requestMessage.digest) return "order";
  const planAnchor = anchorInfo(planMessage);
  const requestAnchor = anchorInfo(requestMessage);
  if (!planAnchor.eligible || !requestAnchor.eligible) return "content-changed";
  if (planAnchor.anchor === null && requestAnchor.anchor === null) return "content-changed";
  if (planAnchor.strippedDigest !== requestAnchor.strippedDigest) return "content-changed";
  if (
    planAnchor.anchor !== null &&
    requestAnchor.anchor !== null &&
    planAnchor.anchor !== requestAnchor.anchor
  ) {
    return "content-changed";
  }
  return "anchor-presentation";
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): AlignmentPair[] {
  const n = left.length;
  const m = right.length;
  if (n === 0 || m === 0) return [];
  if (n * m > 400_000) return greedyMatch(left, right);
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i];
    const next = table[i + 1];
    if (row === undefined || next === undefined) continue;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = left[i] === right[j]
        ? (next[j + 1] ?? 0) + 1
        : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const pairs: AlignmentPair[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      pairs.push({ planIndex: i, requestIndex: j });
      i += 1;
      j += 1;
      continue;
    }
    const down = table[i + 1]?.[j] ?? 0;
    const ahead = table[i]?.[j + 1] ?? 0;
    if (down >= ahead) i += 1;
    else j += 1;
  }
  return pairs;
}

/** Bounded fallback for pathological message counts: match in order, skip gaps. */
function greedyMatch(left: readonly string[], right: readonly string[]): AlignmentPair[] {
  const pairs: AlignmentPair[] = [];
  let j = 0;
  for (let i = 0; i < left.length && j < right.length; i += 1) {
    for (let probe = j; probe < Math.min(right.length, j + 32); probe += 1) {
      if (left[i] === right[probe]) {
        pairs.push({ planIndex: i, requestIndex: probe });
        j = probe + 1;
        break;
      }
    }
  }
  return pairs;
}

function describePlanCells(
  plan: ContextPlanRecipe | null,
  expected: readonly unknown[] | null,
): SpinePlanCellAudit[] {
  if (plan === null) return [];
  const prepared = expected?.map((message) => describeMessage(normalizeMessage(message), 0)) ?? null;
  return plan.cells.map((cell, index) => {
    const expectedMessage = prepared?.[index] ?? null;
    return {
      index,
      type: cell.type,
      label: cell.type === "source"
        ? `source ${cell.source_id.epoch}:${cell.source_id.ordinal}${cell.labels.length > 0 ? ` · U${cell.labels.map((label) => label.UserAnchor).join(",U")}` : ""}`
        : `projection ${projectionLabel(cell.item)}`,
      expected: expectedMessage === null ? null : { ...expectedMessage, index },
      matchedRequestIndex: null,
      note: expected === null ? "Plan cell was not materialized." : null,
    };
  });
}

function projectionLabel(item: unknown): string {
  if (!isRecord(item)) return "unknown";
  if ("SyntheticNode" in item) return "synthetic-node";
  if ("SourceSpan" in item) return "source-span";
  if ("MemorySlot" in item) {
    const slot = item.MemorySlot;
    if (isRecord(slot) && "Summary" in slot) return "memory-summary";
    if (isRecord(slot) && "SpawnEvidence" in slot) return "memory-spawn";
    if (isRecord(slot) && "User" in slot) return "memory-user";
  }
  return Object.keys(item)[0] ?? "unknown";
}

function describeEntries(entries: readonly { index: number; message: NormalizedMessage }[]): SpineAuditMessage[] {
  return entries.map((entry) => describeMessage(entry.message, entry.index));
}

function describeMessage(message: NormalizedMessage, index: number): SpineAuditMessage {
  return {
    index,
    role: message.role,
    sourceKind: message.sourceKind,
    messageId: message.messageId,
    digest: message.digest,
    chars: message.chars,
    preview: message.preview,
  };
}

function describeHostLayer(
  messages: readonly unknown[],
  system: string | undefined,
  tools: readonly unknown[] | undefined,
): SpineAuditHostLayer {
  let systemMessages = 0;
  let developerMessages = 0;
  let leadingSystem = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    if (message.role === "system") {
      systemMessages += 1;
      if (index === 0) leadingSystem = true;
    } else if (message.role === "developer") {
      developerMessages += 1;
    }
  }
  const names: string[] = [];
  for (const tool of tools ?? []) {
    if (isRecord(tool)) {
      const name = typeof tool.name === "string" ? tool.name : typeof tool.id === "string" ? tool.id : null;
      if (name !== null) names.push(name);
    }
  }
  return {
    leadingSystem,
    systemMessages,
    developerMessages,
    systemText: typeof system === "string" && system.length > 0,
    toolCount: names.length,
    toolNames: names,
  };
}

function describeOrigin(message: NormalizedMessage | undefined): string {
  if (message === undefined) return "unknown";
  if (message.role === "assistant" || message.role === "tool") {
    return `role ${message.role}; not in the plan`;
  }
  if (message.sourceKind === "user") return "user input; not in the plan";
  if (message.sourceKind === "none") return `role ${message.role}; provenance unknown`;
  return `source ${message.sourceKind}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
