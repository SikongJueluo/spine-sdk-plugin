/**
 * Read-only view model of one Spine tree for the Web inspection surface.
 *
 * The DTOs here are deliberately JSON-only and independent of Cordis, so the
 * same builder serves live Sessions, reconstructed historical Sessions, and
 * tests. Building a view never mutates Spine: it maps an already-committed
 * `SpineProjection` plus plugin-owned audit data into display records.
 */
import type {
  ContextItem,
  MemorySlot,
  NodeSnapshot,
  SpineProjection,
} from "@spinejit/spine-sdk";

export const SPINE_VIEW_SCHEMA = "spine.dsh.view.v1" as const;
export const SPINE_REQUEST_SCHEMA = "spine.dsh.request.v1" as const;

export type SpineNodeStatus = NodeSnapshot["status"];

export interface SpineViewSpan {
  start: number;
  end: number;
}

export type SpineViewMemory =
  | {
      kind: "user";
      ownerNode: string;
      anchor: number;
      boundary: number;
      role: string;
      text: string;
    }
  | {
      kind: "summary";
      ownerNode: string;
      span: SpineViewSpan;
      body: string;
    }
  | {
      kind: "spawn";
      ownerNode: string;
      span: SpineViewSpan;
      taskSummary: string;
      taskPrompt: string;
      outcome: string;
      diagnostic: string | null;
      executionRef: string | null;
    };

export interface SpineViewNode {
  id: string;
  path: number[];
  parentId: string | null;
  /** Child ids in projection order. */
  childIds: string[];
  depth: number;
  kind: NodeSnapshot["kind"];
  status: SpineNodeStatus;
  summary: string | null;
  start: number;
  end: number | null;
  memory: SpineViewMemory[];
  /** The execution cursor sits exactly on this node. */
  cursor: boolean;
  /** The execution cursor sits inside this node's subtree. */
  onCursorPath: boolean;
}

export interface SpineViewCounts {
  nodes: number;
  live: number;
  opened: number;
  closed: number;
  compacted: number;
  tasks: number;
  memory: number;
}

export interface SpineTreeView {
  state: "live" | "recovered" | "unavailable";
  evidence: "live" | "reconstructed" | "none";
  note: string | null;
  thread: string | null;
  epoch: number | null;
  cursorId: string | null;
  cursorPath: number[] | null;
  lastBoundary: number | null;
  nodes: SpineViewNode[];
  counts: SpineViewCounts;
  visibleContext: { count: number; kinds: Record<string, number> };
}

export type SpineAuditStatus =
  | "consistent"
  | "known-differences"
  | "unexplained"
  | "insufficient";

export interface SpineRequestSummary {
  id: string;
  at: number;
  purpose: string | null;
  attempt: number;
  provider: string;
  model: string;
  messageCount: number;
  toolCount: number;
  bytes: number;
  truncated: boolean;
  hasPlan: boolean;
  evidence: "live" | "reconstructed";
  audit: {
    status: SpineAuditStatus;
    expected: number;
    actual: number;
    matched: number;
    known: number;
    unexplained: number;
  };
}

export interface SpineSessionView {
  schema: typeof SPINE_VIEW_SCHEMA;
  sessionId: string;
  revision: number;
  observedAt: number;
  host: { available: boolean; reason: string | null; message: string | null };
  spine: SpineTreeView;
  activity: { sampling: boolean; label: string | null };
  fault: { message: string; since: number } | null;
  requests: SpineRequestSummary[];
  evidence: {
    store: "ok" | "unavailable" | "error";
    captured: number;
    message: string | null;
  };
  ledger: { entries: number; archives: number; spawnTerminals: number } | null;
}

export function unavailableTree(note: string): SpineTreeView {
  return {
    state: "unavailable",
    evidence: "none",
    note,
    thread: null,
    epoch: null,
    cursorId: null,
    cursorPath: null,
    lastBoundary: null,
    nodes: [],
    counts: { nodes: 0, live: 0, opened: 0, closed: 0, compacted: 0, tasks: 0, memory: 0 },
    visibleContext: { count: 0, kinds: {} },
  };
}

/** Map one committed Spine projection into the display tree. */
export function buildTreeView(
  projection: SpineProjection,
  options: {
    state: "live" | "recovered";
    evidence: "live" | "reconstructed";
    note?: string | null;
    thread?: string | null;
    epoch?: number | null;
  },
): SpineTreeView {
  const cursorPath = projection.cursor.length > 0 ? projection.cursor : null;
  const nodes = layoutNodes(projection.nodes, cursorPath);
  const counts: SpineViewCounts = {
    nodes: nodes.length,
    live: 0,
    opened: 0,
    closed: 0,
    compacted: 0,
    tasks: 0,
    memory: 0,
  };
  for (const node of nodes) {
    if (node.kind === "Task") counts.tasks += 1;
    counts.memory += node.memory.length;
    switch (node.status) {
      case "Live": counts.live += 1; break;
      case "Opened": counts.opened += 1; break;
      case "Closed": counts.closed += 1; break;
      case "Compacted": counts.compacted += 1; break;
      default: break;
    }
  }
  const kinds: Record<string, number> = {};
  for (const item of projection.visible_context) {
    const kind = contextItemKind(item);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return {
    state: options.state,
    evidence: options.evidence,
    note: options.note ?? null,
    thread: options.thread ?? null,
    epoch: options.epoch ?? null,
    cursorId: cursorPath === null ? null : pathKey(cursorPath),
    cursorPath,
    lastBoundary: projection.last_boundary,
    nodes,
    counts,
    visibleContext: { count: projection.visible_context.length, kinds },
  };
}

/**
 * Order nodes depth-first from their parent links.
 *
 * `NodeSnapshot.children` carries ids but a defensive Session may omit or
 * reorder them, so the parent link is authoritative and the projection order
 * breaks ties among siblings. Nodes whose parent is missing become roots; a
 * cycle cannot hide every node because the traversal marks each id once.
 */
export function layoutNodes(
  input: readonly NodeSnapshot[],
  cursorPath: readonly number[] | null,
): SpineViewNode[] {
  const byKey = new Map<string, NodeSnapshot>();
  for (const node of input) byKey.set(pathKey(node.id), node);
  const childKeys = new Map<string | null, string[]>();
  for (const node of input) {
    const key = pathKey(node.id);
    const parentKey = node.parent === null ? null : pathKey(node.parent);
    const parent = parentKey === null ? null : parentKey;
    const bucket = childKeys.get(parent ?? null) ?? [];
    bucket.push(key);
    childKeys.set(parent ?? null, bucket);
  }
  // Keep only sibling lists that follow projection order.
  const order = new Map(input.map((node, index) => [pathKey(node.id), index]));
  for (const [key, bucket] of childKeys) {
    bucket.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    childKeys.set(key, bucket);
  }
  const roots = input
    .filter((node) => node.parent === null || !byKey.has(pathKey(node.parent)))
    .map((node) => pathKey(node.id));
  const cursorKey = cursorPath === null ? null : pathKey(cursorPath);
  const output: SpineViewNode[] = [];
  const visited = new Set<string>();
  const walk = (key: string, depth: number): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const node = byKey.get(key);
    if (node === undefined) return;
    const childIds = childKeys.get(key) ?? [];
    const path = [...node.id];
    output.push({
      id: key,
      path,
      parentId: node.parent === null ? null : pathKey(node.parent),
      childIds: childIds.filter((child) => child !== key),
      depth,
      kind: node.kind,
      status: node.status,
      summary: node.summary,
      start: node.start,
      end: node.end,
      memory: (node.memory ?? []).map((slot) => memoryView(slot, key)),
      cursor: cursorKey === key,
      onCursorPath: cursorKey !== null && isPrefix(path, cursorPath ?? []),
    });
    for (const child of childIds) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // A projection with no root link (or an unvisited cycle) still renders.
  for (const key of byKey.keys()) walk(key, 0);
  return output;
}

function memoryView(slot: MemorySlot, ownerNode: string): SpineViewMemory {
  if ("User" in slot) {
    const user = slot.User;
    return {
      kind: "user",
      ownerNode,
      anchor: user.anchor,
      boundary: user.message.boundary,
      role: user.message.role,
      text: user.message.content,
    };
  }
  if ("Summary" in slot) {
    const summary = slot.Summary;
    return {
      kind: "summary",
      ownerNode,
      span: { start: summary.source.start, end: summary.source.end },
      body: summary.body,
    };
  }
  const evidence = slot.SpawnEvidence;
  return {
    kind: "spawn",
    ownerNode,
    span: { start: evidence.source.start, end: evidence.source.end },
    taskSummary: evidence.task.summary,
    taskPrompt: evidence.task.prompt,
    outcome: evidence.outcome,
    diagnostic: evidence.diagnostic ?? null,
    executionRef: evidence.execution_ref ?? null,
  };
}

function contextItemKind(item: ContextItem): string {
  if ("Message" in item) return "message";
  if ("SourceSpan" in item) return "source-span";
  if ("SyntheticNode" in item) return "synthetic-node";
  if ("Native" in item) return "native";
  if ("MemorySlot" in item) {
    if ("User" in item.MemorySlot) return "memory-user";
    if ("Summary" in item.MemorySlot) return "memory-summary";
    return "memory-spawn";
  }
  return "unknown";
}

export function pathKey(path: readonly number[]): string {
  return path.join(".");
}

export function isPrefix(prefix: readonly number[], full: readonly number[]): boolean {
  if (prefix.length > full.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== full[index]) return false;
  }
  return true;
}

/** Count a session's ledger records by kind for the view footer. */
export function ledgerCounts(
  entries: readonly { kind: "archive" | "spawn-terminal" }[],
): { entries: number; archives: number; spawnTerminals: number } {
  let archives = 0;
  let spawnTerminals = 0;
  for (const entry of entries) {
    if (entry.kind === "archive") archives += 1;
    else spawnTerminals += 1;
  }
  return { entries: entries.length, archives, spawnTerminals };
}
