/**
 * Frozen request evidence: what DSH assembled for one model call, plus the
 * Spine plan that was current for that call and the audit between them.
 *
 * Evidence lives in its own durable domain (`spine_dsh_audit`) instead of the
 * Session log or the Spine ledger: it is an observation, not canonical state,
 * and it must survive a restart without being replayed into either source of
 * truth. Nothing here is ever fed back to a model.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { ContextPlanRecipe } from "@spinejit/spine-sdk";
import type { DomainFacility, DomainSpec } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

import { auditRequest, type SpineAuditResult } from "./audit.js";
import {
  SPINE_REQUEST_SCHEMA,
  type SpineRequestSummary,
} from "./view.js";

export const SPINE_AUDIT_DOMAIN = "spine_dsh_audit" as const;
export const SPINE_AUDIT_DOMAIN_VERSION = 1 as const;
export const DEFAULT_REQUEST_RETENTION = 100;
export const MAX_CAPTURED_REQUEST_BYTES = 2 * 1024 * 1024;
/** Safety margin for the `bytes` field's own digits and JSON framing. */
const EVIDENCE_BUDGET = MAX_CAPTURED_REQUEST_BYTES - 128;
const TRUNCATED_TEXT_CHARS = 4_000;
const COMPRESSED_TEXT_CHARS = 1_000;
const HARD_MESSAGE_LIMIT = 400;
const HARD_PLAN_STRING_CHARS = 2_000;

export interface CapturedRequestRecord {
  schema: typeof SPINE_REQUEST_SCHEMA;
  sessionId: string;
  sessionCreatedAt: number;
  requestId: string;
  capturedAt: number;
  purpose: string | null;
  attempt: number;
  /** Identity of the plan version this request was bound to. */
  planId: string | null;
  provider: string;
  model: string;
  reasoningEffort: string | null;
  system: string | null;
  messages: unknown[];
  tools: unknown[];
  toolNames: string[];
  plan: ContextPlanRecipe | null;
  planDigest: string | null;
  audit: SpineAuditResult;
  truncated: boolean;
  bytes: number;
}

export interface FreezeRequestInput {
  sessionId: string;
  sessionCreatedAt: number;
  requestId: string;
  capturedAt: number;
  purpose: string | null;
  attempt: number;
  /** Identity of the plan version this request was bound to. */
  planId?: string | null;
  request: unknown;
  plan: ContextPlanRecipe | null;
  /** Materialized plan messages, or null when materialization failed. */
  expected: readonly unknown[] | null;
  planError?: string | null;
}

/**
 * Detach and bound one frozen `GenerateOptions`.
 *
 * The request may be deep-frozen and carries an `AbortSignal`; only plain JSON
 * fields are copied, and an oversized body is reduced before storage so the
 * audit store never grows without bound. Truncation is recorded on the record
 * and forces the audit to `insufficient` instead of a false pass.
 */
export function freezeRequest(input: FreezeRequestInput): CapturedRequestRecord {
  const request = isRecord(input.request) ? input.request : {};
  let messages = jsonArray(request.messages);
  let tools = jsonArray(request.tools);
  let truncated = false;
  if (messages.length > HARD_MESSAGE_LIMIT) {
    messages = messages.slice(0, HARD_MESSAGE_LIMIT);
    truncated = true;
  }
  let system = typeof request.system === "string" ? request.system : null;
  let plan = input.plan === null ? null : jsonValue(input.plan) as ContextPlanRecipe;
  if (jsonBytes({ messages, tools, system, plan }) > EVIDENCE_BUDGET) {
    messages = messages.map(compressMessage);
    tools = tools.map(compressTool);
    system = system === null ? null : compressText(system, COMPRESSED_TEXT_CHARS);
    plan = compressPlan(plan);
    truncated = true;
  }
  const toolNames = tools.map((tool) => {
    if (!isRecord(tool)) return "unknown";
    if (typeof tool.name === "string") return tool.name;
    if (typeof tool.id === "string") return tool.id;
    return "unknown";
  });
  const audit = auditRequest({
    plan: input.plan,
    expected: input.expected,
    actual: messages,
    system: system ?? undefined,
    truncated,
    planError: input.planError ?? null,
    tools,
  });
  return boundEvidence({
    schema: SPINE_REQUEST_SCHEMA,
    sessionId: input.sessionId,
    sessionCreatedAt: input.sessionCreatedAt,
    requestId: input.requestId,
    capturedAt: input.capturedAt,
    purpose: input.purpose,
    attempt: input.attempt,
    planId: input.planId ?? null,
    provider: typeof request.provider === "string" ? request.provider : "unknown",
    model: typeof request.model === "string" ? request.model : "unknown",
    reasoningEffort: typeof request.reasoningEffort === "string" ? request.reasoningEffort : null,
    system,
    messages,
    tools,
    toolNames,
    plan,
    planDigest: plan === null ? null : planDigest(plan),
    audit: jsonValue(audit) as SpineAuditResult,
    truncated,
    bytes: 0,
  });
}

/**
 * Enforce a verifiable hard bound on the complete durable record.
 *
 * Compression runs first, then the oldest messages are dropped, and finally a
 * stub replaces a record that still cannot fit. Every reduction sets
 * `truncated` and rewrites the audit to `insufficient`, so the stored evidence
 * never claims a comparison the retained bytes cannot support. `bytes` is the
 * serialized size of the record actually stored.
 */
function boundEvidence(record: CapturedRequestRecord): CapturedRequestRecord {
  let candidate = record;
  let size = jsonBytes(candidate);
  if (size <= EVIDENCE_BUDGET) return { ...candidate, bytes: size };

  candidate = {
    ...candidate,
    messages: candidate.messages.map(compressMessage),
    tools: candidate.tools.map(compressTool),
    system: candidate.system === null ? null : compressText(candidate.system, COMPRESSED_TEXT_CHARS),
    plan: compressPlan(candidate.plan, 500),
    truncated: true,
  };
  candidate = { ...candidate, audit: insufficientAudit(candidate.audit) };
  size = jsonBytes(candidate);
  if (size <= EVIDENCE_BUDGET) return { ...candidate, bytes: size };

  const messages = [...candidate.messages];
  while (messages.length > 0) {
    messages.shift();
    const next = { ...candidate, messages };
    size = jsonBytes(next);
    if (size <= EVIDENCE_BUDGET) {
      return { ...next, bytes: size, audit: insufficientAudit(next.audit, messages.length) };
    }
  }

  const stub: CapturedRequestRecord = {
    ...candidate,
    messages: [],
    tools: [],
    toolNames: [],
    system: null,
    plan: null,
    planDigest: null,
    truncated: true,
    audit: {
      status: "insufficient",
      planCells: [],
      spineMessages: [],
      hostLayer: {
        leadingSystem: false,
        systemMessages: 0,
        developerMessages: 0,
        systemText: false,
        toolCount: 0,
        toolNames: [],
      },
      expectedCount: 0,
      actualCount: 0,
      matchedCount: 0,
      differences: [{
        category: "truncated",
        detail: "The request exceeded the evidence bound and was not retained.",
        planIndex: null,
        requestIndex: null,
        expected: null,
        actual: null,
      }],
      notes: ["The complete request exceeded the storage bound, so no request body was kept."],
    },
    bytes: 0,
  };
  return { ...stub, bytes: jsonBytes(stub) };
}

function insufficientAudit(audit: SpineAuditResult, actualCount = audit.actualCount): SpineAuditResult {
  const differences = audit.differences.filter((difference) => difference.category === "truncated");
  if (differences.length === 0) {
    differences.push({
      category: "truncated",
      detail: "The stored evidence was reduced to satisfy the evidence bound.",
      planIndex: null,
      requestIndex: null,
      expected: null,
      actual: null,
    });
  }
  return {
    ...audit,
    status: "insufficient",
    planCells: audit.planCells.map((cell) => ({ ...cell, matchedRequestIndex: null })),
    spineMessages: [],
    matchedCount: 0,
    actualCount,
    differences,
    notes: [...audit.notes, "The stored request body was bounded; it is not the complete evidence."],
  };
}

export function summarizeRequest(record: CapturedRequestRecord): SpineRequestSummary {
  const audit = record.audit;
  const unexplained = audit.differences.filter((difference) =>
    difference.category !== "anchor-presentation").length;
  return {
    id: record.requestId,
    at: record.capturedAt,
    purpose: record.purpose,
    attempt: record.attempt,
    provider: record.provider,
    model: record.model,
    messageCount: record.messages.length,
    toolCount: record.toolNames.length,
    bytes: record.bytes,
    truncated: record.truncated,
    hasPlan: record.plan !== null,
    evidence: "live",
    audit: {
      status: audit.status,
      expected: audit.expectedCount,
      actual: audit.actualCount,
      matched: audit.matchedCount,
      known: audit.differences.length - unexplained,
      unexplained,
    },
  };
}

export interface DeepSeekHarnessRequestStore {
  append(record: CapturedRequestRecord): Promise<void>;
  summaries(sessionId: string): SpineRequestSummary[];
  detail(sessionId: string, requestId: string): CapturedRequestRecord | null;
  count(sessionId: string): number;
  close(): Promise<void>;
}

export interface DeepSeekHarnessRequestTable {
  entries(): IterableIterator<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface DeepSeekHarnessRequestDomain {
  table(name: string): DeepSeekHarnessRequestTable;
  close(): Promise<void>;
}

const requestRecordSchema = z.object({
  schema: z.literal(SPINE_REQUEST_SCHEMA),
  sessionId: z.string().min(1),
  sessionCreatedAt: z.number().int().nonnegative(),
  requestId: z.string().min(1),
  capturedAt: z.number().int().nonnegative(),
  purpose: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  // Added after the first v1 evidence records existed. Missing means "not
  // recorded", not corruption: old valid evidence must stay readable.
  planId: z.string().min(1).nullable().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().nullable(),
  system: z.string().nullable(),
  messages: z.array(z.unknown()),
  tools: z.array(z.unknown()),
  toolNames: z.array(z.string()),
  plan: z.unknown().nullable(),
  planDigest: z.string().nullable(),
  audit: z.object({
    status: z.enum(["consistent", "known-differences", "unexplained", "insufficient"]),
    differences: z.array(z.unknown()),
    notes: z.array(z.string()),
  }).passthrough(),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
}).passthrough();

/**
 * Corrupt evidence is reported, never skipped: the default reject-on-invalid
 * policy makes the whole audit store unreadable, which the view surfaces with
 * the exact failure instead of presenting the surviving records as complete.
 * The tree reader keeps working because the extension opens this store lazily
 * and isolates its failure.
 */
export const SPINE_AUDIT_DOMAIN_SPEC: DomainSpec = {
  name: SPINE_AUDIT_DOMAIN,
  version: SPINE_AUDIT_DOMAIN_VERSION,
  layout: "per-record",
  tables: {
    requests: { valueSchema: requestRecordSchema },
  },
};

export async function openDeepSeekHarnessRequestStore(
  facility: Pick<DomainFacility, "open">,
  options: { retention?: number } = {},
): Promise<DeepSeekHarnessRequestStore> {
  const domain = await facility.open(SPINE_AUDIT_DOMAIN_SPEC) as unknown as DeepSeekHarnessRequestDomain;
  return new DomainDeepSeekHarnessRequestStore(domain, options.retention ?? DEFAULT_REQUEST_RETENTION);
}

export class DomainDeepSeekHarnessRequestStore implements DeepSeekHarnessRequestStore {
  readonly #domain: DeepSeekHarnessRequestDomain;
  readonly #table: DeepSeekHarnessRequestTable;
  readonly #retention: number;
  readonly #bySession = new Map<string, Map<string, { record: CapturedRequestRecord; key: string }>>();
  #closed = false;

  constructor(domain: DeepSeekHarnessRequestDomain, retention: number) {
    this.#domain = domain;
    this.#retention = Math.max(1, retention);
    this.#table = domain.table("requests");
    for (const [key, raw] of this.#table.entries()) {
      const record = decodeRequestRecord(key, raw);
      const session = this.#session(record.sessionId);
      session.set(record.requestId, { record, key });
    }
  }

  async append(record: CapturedRequestRecord): Promise<void> {
    this.#assertOpen();
    const session = this.#session(record.sessionId);
    if (session.has(record.requestId)) return;
    const key = requestKey(record.sessionId, record.capturedAt, record.requestId);
    await this.#table.put(key, record);
    session.set(record.requestId, { record, key });
    await this.#prune(record.sessionId, session);
  }

  summaries(sessionId: string): SpineRequestSummary[] {
    this.#assertOpen();
    const session = this.#session(sessionId);
    return [...session.values()]
      .map(({ record }) => record)
      .sort((left, right) => left.capturedAt - right.capturedAt || left.attempt - right.attempt)
      .map(summarizeRequest);
  }

  detail(sessionId: string, requestId: string): CapturedRequestRecord | null {
    this.#assertOpen();
    return this.#session(sessionId).get(requestId)?.record ?? null;
  }

  count(sessionId: string): number {
    this.#assertOpen();
    return this.#session(sessionId).size;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#domain.close();
  }

  async #prune(sessionId: string, session: Map<string, { record: CapturedRequestRecord; key: string }>): Promise<void> {
    if (session.size <= this.#retention) return;
    const ordered = [...session.entries()].sort((left, right) =>
      left[1].record.capturedAt - right[1].record.capturedAt ||
      left[1].record.attempt - right[1].record.attempt);
    const excess = ordered.slice(0, session.size - this.#retention);
    for (const [requestId, entry] of excess) {
      await this.#table.delete(entry.key);
      session.delete(requestId);
    }
  }

  #session(sessionId: string) {
    let session = this.#bySession.get(sessionId);
    if (session === undefined) {
      session = new Map();
      this.#bySession.set(sessionId, session);
    }
    return session;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Spine request evidence store is closed");
  }
}

/** In-memory store for tests and minimal embeddings. */
export class MemoryDeepSeekHarnessRequestStore implements DeepSeekHarnessRequestStore {
  readonly #bySession = new Map<string, CapturedRequestRecord[]>();
  readonly #retention: number;
  #closed = false;

  constructor(retention = DEFAULT_REQUEST_RETENTION) {
    this.#retention = Math.max(1, retention);
  }

  async append(record: CapturedRequestRecord): Promise<void> {
    const session = this.#records(record.sessionId);
    if (session.some((entry) => entry.requestId === record.requestId)) return;
    session.push(record);
    if (session.length > this.#retention) session.splice(0, session.length - this.#retention);
  }

  summaries(sessionId: string): SpineRequestSummary[] {
    return [...this.#records(sessionId)].map(summarizeRequest);
  }

  detail(sessionId: string, requestId: string): CapturedRequestRecord | null {
    return this.#records(sessionId).find((record) => record.requestId === requestId) ?? null;
  }

  count(sessionId: string): number {
    return this.#records(sessionId).length;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #records(sessionId: string): CapturedRequestRecord[] {
    let records = this.#bySession.get(sessionId);
    if (records === undefined) {
      records = [];
      this.#bySession.set(sessionId, records);
    }
    return records;
  }
}

export function requestKey(sessionId: string, capturedAt: number, requestId: string): string {
  const session = Buffer.from(sessionId, "utf8").toString("base64url");
  return `${session}_${String(capturedAt).padStart(16, "0")}_${requestId.replaceAll("/", "_")}`;
}

function decodeRequestRecord(key: string, value: unknown): CapturedRequestRecord {
  const result = requestRecordSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Spine request evidence record "${key}" is invalid`, { cause: result.error });
  }
  const record = value as CapturedRequestRecord & { planId?: string | null };
  // Evidence written before `planId` existed is valid v1 evidence; normalize the
  // absent field to the same "unknown" value the UI already renders.
  return { ...record, planId: record.planId ?? null };
}

function compressMessage(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const content = Array.isArray(value.content) ? value.content.map(compressBlock) : value.content;
  return { ...value, content: jsonValue(content) };
}

function compressBlock(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.type === "text" && typeof value.text === "string") {
    return { ...value, text: compressText(value.text, COMPRESSED_TEXT_CHARS) };
  }
  if (value.type === "tool-call") {
    const copy: Record<string, unknown> = { ...value };
    if (typeof copy.arguments === "string") copy.arguments = compressText(copy.arguments, COMPRESSED_TEXT_CHARS);
    else if (copy.arguments !== undefined) copy.arguments = compressJson(copy.arguments, HARD_PLAN_STRING_CHARS);
    return copy;
  }
  if (value.type === "image") {
    const bytes = jsonBytes(value);
    if (bytes > HARD_PLAN_STRING_CHARS) return { type: "image", truncated: true, bytes };
    return value;
  }
  if (jsonBytes(value) > HARD_PLAN_STRING_CHARS) {
    return {
      type: typeof value.type === "string" ? value.type : "unknown",
      truncated: true,
      bytes: jsonBytes(value),
    };
  }
  return value;
}

function compressTool(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = { ...value };
  if (typeof copy.description === "string") {
    copy.description = compressText(copy.description, COMPRESSED_TEXT_CHARS);
  }
  if (copy.parameters !== undefined) copy.parameters = compressJson(copy.parameters, HARD_PLAN_STRING_CHARS);
  return copy;
}

/** Truncate every long string inside a JSON value without dropping its shape. */
function compressJson(value: unknown, maxChars: number, depth = 0): unknown {
  if (depth > 24) return value;
  if (typeof value === "string") return compressText(value, maxChars);
  if (Array.isArray(value)) return value.map((entry) => compressJson(entry, maxChars, depth + 1));
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = compressJson(entry, maxChars, depth + 1);
    }
    return output;
  }
  return value;
}

/** Bound every string in a stored plan; identities and digests are short. */
function compressPlan(plan: ContextPlanRecipe | null, maxChars = HARD_PLAN_STRING_CHARS): ContextPlanRecipe | null {
  if (plan === null) return null;
  return compressJson(plan, maxChars) as ContextPlanRecipe;
}

function compressText(text: string, maxChars: number): string {
  if (text.length <= maxChars * 2) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars * 2} chars]…\n${text.slice(-maxChars)}`;
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map(jsonValue) : [];
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function planDigest(plan: unknown): string | null {
  try {
    return createHash("sha256").update(JSON.stringify(plan) ?? "null", "utf8").digest("hex");
  } catch {
    return null;
  }
}

function jsonValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
