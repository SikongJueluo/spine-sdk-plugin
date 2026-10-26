import assert from "node:assert/strict";
import test from "node:test";

import {
  DeepSeekHarnessInspection,
  MemoryDeepSeekHarnessRequestStore,
  freezeRequest,
} from "../dist/deepseek-harness/index.js";
import { createSpineInspectionHost } from "../../spine-tree/host/broker.js";
import {
  createSpineRoutes,
  SPINE_TREE_PATH,
} from "../../spine-tree/host/routes.js";

function inspection(requests) {
  return new DeepSeekHarnessInspection({
    ledger: async () => ({
      findSession: async () => undefined,
      entries: async () => [],
    }),
    requests,
    inspectSession: async () => ({ events: [], createdAt: 5 }),
    runtimeFactory: () => ({ client: {}, dispose() {} }),
    now: () => 50,
  });
}

function contribution(id, source) {
  return {
    id,
    presetId: "personal",
    view: (sessionId, request) => source.view(sessionId, request),
    request: (sessionId, requestId) => source.request(sessionId, requestId),
  };
}

function treeUrl(sessionId, cursor = {}) {
  const params = new URLSearchParams({ sessionId });
  if (cursor.since !== undefined) params.set("since", String(cursor.since));
  if (cursor.source !== undefined) params.set("source", cursor.source);
  return new Request(`http://host${SPINE_TREE_PATH}?${params.toString()}`);
}

async function readTree(routes, sessionId, cursor) {
  return (await routes.tree(treeUrl(sessionId, cursor))).json();
}

test("a cursor from an unloaded source cannot match its replacement", async () => {
  const store = new MemoryDeepSeekHarnessRequestStore();
  await store.append(freezeRequest({
    sessionId: "session-1",
    sessionCreatedAt: 5,
    requestId: "request-1",
    capturedAt: 10,
    purpose: null,
    attempt: 0,
    request: { provider: "provider", model: "model", messages: [] },
    plan: null,
    expected: null,
  }));
  const oldInspection = inspection(undefined);
  const newInspection = inspection(async () => store);
  const broker = createSpineInspectionHost({ presetOf: async () => "personal" });
  const routes = createSpineRoutes({ service: () => broker, now: () => 100 });

  const releaseOld = broker.register(contribution("old", oldInspection));
  const clientA = await readTree(routes, "session-1");
  assert.equal(clientA.revision, 1);
  assert.equal(clientA.requests.length, 0);

  releaseOld();
  const releaseNew = broker.register(contribution("new", newInspection));
  const clientB = await readTree(routes, "session-1");
  assert.equal(clientB.revision, 1, "the replacement starts at the same local revision");
  assert.equal(clientB.requests.length, 1);
  assert.notEqual(clientB.source, clientA.source);

  const stale = await readTree(routes, "session-1", { since: 1, source: clientA.source });
  assert.equal(stale.unchanged, undefined);
  assert.equal(stale.source, clientB.source);
  assert.equal(stale.requests.length, 1);

  const fresh = await readTree(routes, "session-1", { since: 1, source: clientB.source });
  assert.equal(fresh.unchanged, true);
  assert.equal(fresh.source, clientB.source);

  releaseNew();
  await oldInspection.close();
  await newInspection.close();
});

test("a replacement inspection with the same revision cannot satisfy an old cursor", async () => {
  const store = new MemoryDeepSeekHarnessRequestStore();
  await store.append(freezeRequest({
    sessionId: "session-1",
    sessionCreatedAt: 5,
    requestId: "request-1",
    capturedAt: 10,
    purpose: null,
    attempt: 0,
    request: { provider: "provider", model: "model", messages: [] },
    plan: null,
    expected: null,
  }));

  const oldInspection = inspection(undefined);
  const newInspection = inspection(async () => store);
  // Both sources independently start their local counter at the same value.
  assert.equal((await oldInspection.view("session-1")).revision, 1);
  assert.equal((await newInspection.view("session-1")).revision, 1);

  const broker = createSpineInspectionHost({ presetOf: async () => "personal" });
  const routes = createSpineRoutes({ service: () => broker, now: () => 100 });
  const releaseOld = broker.register(contribution("old", oldInspection));

  // Client A: old source, no request evidence.
  const clientA = await readTree(routes, "session-1");
  assert.equal(clientA.revision, 1);
  assert.equal(clientA.requests.length, 0);
  assert.equal(clientA.evidence.store, "unavailable");
  assert.equal(typeof clientA.source, "string");

  // A replacement same-preset revision becomes the standing source. Its first
  // view has the same revision number but more evidence.
  const releaseNew = broker.register(contribution("new", newInspection));
  const clientB = await readTree(routes, "session-1");
  assert.equal(clientB.revision, 1);
  assert.equal(clientB.requests.length, 1);
  assert.equal(clientB.evidence.store, "ok");
  assert.notEqual(clientB.source, clientA.source);

  // Client A keeps polling with its old source + revision. It must receive the
  // new baseline every time rather than an `unchanged` reply.
  for (let index = 0; index < 3; index += 1) {
    const next = await readTree(routes, "session-1", { since: 1, source: clientA.source });
    assert.equal(next.unchanged, undefined);
    assert.equal(next.source, clientB.source);
    assert.equal(next.revision, 1);
    assert.equal(next.requests.length, 1);
  }

  // A numeric cursor without a source generation is never trusted.
  const legacy = await readTree(routes, "session-1", { since: 1 });
  assert.equal(legacy.unchanged, undefined);
  assert.equal(legacy.source, clientB.source);

  // Client B still gets the ordinary same-source short circuit.
  const unchanged = await readTree(routes, "session-1", { since: 1, source: clientB.source });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.revision, 1);
  assert.equal(unchanged.source, clientB.source);

  // Retiring the old contribution does not churn the standing source.
  releaseOld();
  const afterRetire = await readTree(routes, "session-1", { since: 1, source: clientB.source });
  assert.equal(afterRetire.unchanged, true);
  assert.equal(afterRetire.source, clientB.source);
  const staleA = await readTree(routes, "session-1", { since: 1, source: clientA.source });
  assert.equal(staleA.unchanged, undefined);
  assert.equal(staleA.source, clientB.source);

  // Unloading the standing revision clears the source, so the next client gets
  // an explicit no-source baseline instead of matching a retired cursor.
  releaseNew();
  const none = await readTree(routes, "session-1", { since: 1, source: clientB.source });
  assert.equal(none.unchanged, undefined);
  assert.equal(none.source, null);
  assert.equal(none.host.available, false);

  await oldInspection.close();
  await newInspection.close();
});
