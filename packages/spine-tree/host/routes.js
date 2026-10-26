/**
 * Read-only Fetch handlers for the Spine Tree view.
 *
 * Kept free of Cordis so the contract can be exercised directly. The only
 * dependency is an inspection-host accessor and a clock.
 */

/**
 * Build the two Fetch handlers.
 *
 * Pure enough to test without Cordis: the only dependency is a broker
 * accessor and a clock.
 */
export const SPINE_TREE_PATH = "/api/spine.tree";
export const SPINE_REQUEST_PATH = "/api/spine.request";

const MAX_SESSION_ID = 200;
const MAX_REQUEST_ID = 300;
const MAX_SOURCE = 120;

export function createSpineRoutes(options) {
  const host = options.service;
  const now = options.now ?? (() => Date.now());
  return {
    tree: async (request) => {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("sessionId");
      if (!isValidId(sessionId, MAX_SESSION_ID)) {
        return json({ error: "invalid-session" }, 400);
      }
      const since = parseRevision(url.searchParams.get("since"));
      const cursorSource = parseSource(url.searchParams.get("source"));
      const broker = host();
      if (broker === undefined || broker === null) {
        return json(unavailableView(sessionId, now()), 200);
      }
      try {
        const selection = await broker.select(sessionId);
        if (selection.kind !== "ok") {
          return json(unavailableView(sessionId, now(), ...selectionReason(selection)), 200);
        }
        const source = typeof selection.source === "string" ? selection.source : null;
        // A revision number is local to one inspection instance. Only a cursor
        // that names this exact source generation may short-circuit; otherwise
        // the client receives a fresh baseline even when the number matches.
        const sameSource = source !== null && cursorSource === source;
        const view = await selection.contribution.view(
          sessionId,
          sameSource && since !== null ? { since } : {},
        );
        return json(withSource(view, source), 200);
      } catch (error) {
        return json(unavailableView(sessionId, now(), "inspection-failed", messageOf(error)), 200);
      }
    },
    request: async (request) => {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("sessionId");
      const requestId = url.searchParams.get("id");
      if (!isValidId(sessionId, MAX_SESSION_ID) || !isValidId(requestId, MAX_REQUEST_ID)) {
        return json({ ok: false, reason: "invalid-request", detail: null }, 400);
      }
      const broker = host();
      if (broker === undefined || broker === null) {
        return json(notEnabledRequest(), 200);
      }
      try {
        const selection = await broker.select(sessionId);
        if (selection.kind !== "ok") {
          const [reason, message] = selectionReason(selection);
          return json({ ok: false, reason: `${reason}: ${message}`, detail: null }, 200);
        }
        return json(await selection.contribution.request(sessionId, requestId), 200);
      } catch (error) {
        return json({ ok: false, reason: messageOf(error), detail: null }, 200);
      }
    },
  };
}

/** A stable explanation for a selection that names no inspection. */
function selectionReason(selection) {
  if (selection.kind === "ambiguous") {
    const named = selection.presets.length > 0
      ? ` (${selection.presets.join(", ")})`
      : "";
    return [
      "spine-source-ambiguous",
      `More than one Spine-enabled preset could serve this Session${named}; refusing to merge their data.`,
    ];
  }
  if (selection.sources === 0) {
    return [
      "spine-preset-inactive",
      "No Spine-enabled preset is contributing inspection data in this profile.",
    ];
  }
  return [
    "spine-preset-inactive",
    "No active Spine-enabled preset provides this Session. Enable Spine inspection in the preset this Session uses.",
  ];
}

function unavailableView(sessionId, observedAt, reason = "spine-host-inactive", message = null) {
  return {
    schema: "spine.dsh.view.v1",
    sessionId,
    revision: 0,
    source: null,
    observedAt,
    host: {
      available: false,
      reason,
      message: message ?? "The Spine host plugin is not enabled in this profile.",
    },
    spine: {
      state: "unavailable",
      evidence: "none",
      note: message ?? "The Spine host plugin is not enabled in this profile.",
      thread: null,
      epoch: null,
      cursorId: null,
      cursorPath: null,
      lastBoundary: null,
      nodes: [],
      counts: { nodes: 0, live: 0, opened: 0, closed: 0, compacted: 0, tasks: 0, memory: 0 },
      visibleContext: { count: 0, kinds: {} },
    },
    activity: { sampling: false, label: null },
    fault: null,
    requests: [],
    evidence: { store: "unavailable", captured: 0, message: null },
    ledger: null,
  };
}

function notEnabledRequest() {
  return {
    ok: false,
    reason: "The Spine host plugin is not enabled in this profile.",
    detail: null,
  };
}

function json(value, status) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function parseRevision(value) {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

function parseSource(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= MAX_SOURCE ? value : null;
}

/**
 * Name the source generation of every wire view, including an `unchanged`
 * reply. The client echoes it next to the numeric revision so a replacement
 * inspection cannot satisfy a cursor with its own independent counter.
 */
function withSource(view, source) {
  if (view === null || typeof view !== "object") return view;
  return { ...view, source };
}

function isValidId(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
