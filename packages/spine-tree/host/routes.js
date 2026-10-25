/**
 * Read-only Fetch handlers for the Spine Tree view.
 *
 * Kept free of Cordis so the contract can be exercised directly. The only
 * dependency is an inspection-service accessor and a clock.
 */

/**
 * Build the two Fetch handlers.
 *
 * Pure enough to test without Cordis: the only dependency is a service accessor
 * and a clock.
 */
export const SPINE_TREE_PATH = "/api/spine.tree";
export const SPINE_REQUEST_PATH = "/api/spine.request";

const MAX_SESSION_ID = 200;
const MAX_REQUEST_ID = 300;

export function createSpineRoutes(options) {
  const service = options.service;
  const now = options.now ?? (() => Date.now());
  return {
    tree: async (request) => {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("sessionId");
      if (!isValidId(sessionId, MAX_SESSION_ID)) {
        return json({ error: "invalid-session" }, 400);
      }
      const since = parseRevision(url.searchParams.get("since"));
      const inspection = service();
      if (inspection === undefined || inspection === null) {
        return json(unavailableView(sessionId, now()), 200);
      }
      try {
        const view = await inspection.view(sessionId, since === null ? {} : { since });
        return json(view, 200);
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
      const inspection = service();
      if (inspection === undefined || inspection === null) {
        return json(notEnabledRequest(), 200);
      }
      try {
        return json(await inspection.request(sessionId, requestId), 200);
      } catch (error) {
        return json({ ok: false, reason: messageOf(error), detail: null }, 200);
      }
    },
  };
}

function unavailableView(sessionId, observedAt, reason = "spine-host-inactive", message = null) {
  return {
    schema: "spine.dsh.view.v1",
    sessionId,
    revision: 0,
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

function isValidId(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
