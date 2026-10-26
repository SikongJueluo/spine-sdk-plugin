import assert from "node:assert/strict";
import test from "node:test";

import {
  DeepSeekHarnessInspection,
  MemoryDeepSeekHarnessLedger,
  MemoryDeepSeekHarnessRequestStore,
} from "../dist/deepseek-harness/index.js";
import { createSpineInspectionHost } from "../../spine-tree/host/broker.js";
import {
  createSpineRoutes,
  SPINE_TREE_PATH,
} from "../../spine-tree/host/routes.js";

const tick = (milliseconds = 10) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const projection = {
  nodes: [{
    id: [0],
    parent: null,
    children: [],
    kind: "RootEpoch",
    status: "Live",
    summary: "root",
    memory: null,
    start: 0,
    end: null,
  }],
  cursor: [0],
  visible_context: [],
  last_boundary: null,
};

function inspection({ requests, ledger }) {
  return new DeepSeekHarnessInspection({
    ledger: async () => ledger,
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
    hasLive: (sessionId) => source.hasLive(sessionId),
    owns: (sessionId) => source.owns(sessionId),
    view: (sessionId, request) => source.view(sessionId, request),
    request: (sessionId, requestId) => source.request(sessionId, requestId),
  };
}

async function readTree(routes, cursor = {}) {
  const params = new URLSearchParams({ sessionId: "S" });
  if (cursor.since !== undefined) params.set("since", String(cursor.since));
  if (cursor.source !== undefined) params.set("source", cursor.source);
  return (await routes.tree(
    new Request(`http://host${SPINE_TREE_PATH}?${params.toString()}`),
  )).json();
}

test("a retained revision's shared evidence write invalidates the standing cold baseline", async () => {
  const store = new MemoryDeepSeekHarnessRequestStore();
  const ledger = {
    findSession: async () => undefined,
    entries: async () => [],
    dataGeneration: () => 0,
  };
  const oldInspection = inspection({ requests: async () => store, ledger });
  const newInspection = inspection({ requests: async () => store, ledger });
  const broker = createSpineInspectionHost({ presetOf: async () => "personal" });
  const routes = createSpineRoutes({ service: () => broker, now: () => 100 });
  const releaseOld = broker.register(contribution("old", oldInspection));
  const releaseNew = broker.register(contribution("new", newInspection));

  // The standing revision builds and caches a cold baseline with no evidence.
  const baseline = await readTree(routes);
  assert.equal(baseline.revision, 1);
  assert.equal(baseline.requests.length, 0);
  assert.equal(baseline.evidence.store, "ok");
  const newSource = baseline.source;

  const session = {
    id: "S",
    header: { createdAt: 5, agentPreset: "personal" },
    seq: 0,
    snapshotEvents: () => [],
  };
  oldInspection.attach(session);
  oldInspection.reportContext(session, {
    transactionId: null,
    contextPlan: null,
    projection,
  }, "preview");
  const record = oldInspection.captureRequest(session, {
    provider: "provider",
    model: "model",
    sessionId: "S",
    messages: [{ role: "system", content: [] }],
  }, () => []);
  assert.ok(record);
  await tick(20);
  assert.equal(store.count("S"), 1);
  assert.equal(store.dataGeneration("S"), 1);

  // While the old revision holds the Session live it is the selected source;
  // the write is visible there.
  const live = await readTree(routes);
  assert.notEqual(live.source, newSource);
  assert.equal(live.requests.length, 1);

  oldInspection.detach("S");

  // A client that still holds the standing source's baseline cursor must get
  // the rebuilt view too, not `unchanged`.
  const polled = await readTree(routes, { since: baseline.revision, source: newSource });
  assert.equal(polled.unchanged, undefined);
  assert.equal(polled.source, newSource);
  assert.equal(polled.requests.length, 1);

  // The standing revision still holds its cached cold view. A full read (no
  // since/source) must observe the shared write and advance its own revision.
  let last;
  for (let index = 0; index < 3; index += 1) {
    last = await readTree(routes);
    assert.equal(last.source, newSource);
    assert.equal(last.requests.length, 1, "shared evidence is visible after handoff");
    assert.equal(last.unchanged, undefined);
  }
  assert.ok(last.revision > baseline.revision, "the standing reader advances its revision");

  const coldOld = await oldInspection.view("S");
  assert.equal(coldOld.requests.length, 1, "the writing revision sees its own evidence cold");

  const shortCircuit = await readTree(routes, { since: last.revision, source: newSource });
  assert.equal(shortCircuit.unchanged, true);
  assert.equal(shortCircuit.source, newSource);

  releaseOld();
  releaseNew();
  await oldInspection.close();
  await newInspection.close();
});

test("a shared ledger generation invalidates the cold replay cache", async () => {
  let ledgerGeneration = 0;
  let ledgerReads = 0;
  const ledger = {
    findSession: async () => undefined,
    entries: async () => {
      ledgerReads += 1;
      return [];
    },
    dataGeneration: () => ledgerGeneration,
  };
  const source = inspection({ requests: undefined, ledger });
  const broker = createSpineInspectionHost({ presetOf: async () => "personal" });
  const routes = createSpineRoutes({ service: () => broker, now: () => 100 });
  broker.register(contribution("only", source));

  const baseline = await readTree(routes);
  assert.equal(baseline.revision, 1);
  const readsAfterBaseline = ledgerReads;
  assert.ok(readsAfterBaseline > 0, "the first cold read consults the ledger");

  ledgerGeneration = 1;
  const rebuilt = await readTree(routes);
  assert.ok(rebuilt.revision > baseline.revision);
  assert.ok(ledgerReads > readsAfterBaseline, "the invalidated snapshot replays the ledger");

  const shortCircuit = await readTree(routes, {
    since: rebuilt.revision,
    source: rebuilt.source,
  });
  assert.equal(shortCircuit.unchanged, true);
  await source.close();
});

test("both durable stores expose per-session write generations", async () => {
  const requests = new MemoryDeepSeekHarnessRequestStore();
  assert.equal(requests.dataGeneration("S"), 0);
  await requests.append({
    sessionId: "S",
    requestId: "request-1",
    capturedAt: 1,
    attempt: 0,
  });
  assert.equal(requests.dataGeneration("S"), 1);
  await requests.append({
    sessionId: "S",
    requestId: "request-1",
    capturedAt: 1,
    attempt: 0,
  });
  assert.equal(requests.dataGeneration("S"), 1, "a duplicate append is not a write");

  const ledger = new MemoryDeepSeekHarnessLedger();
  assert.equal(ledger.dataGeneration("S"), 0);
  await ledger.appendSpawnTerminal("S", 5, 0, "batch", { ordinal: 0 });
  assert.equal(ledger.dataGeneration("S"), 1);
  await ledger.appendSpawnTerminal("S", 5, 0, "batch", { ordinal: 0 });
  assert.equal(ledger.dataGeneration("S"), 1, "a duplicate spawn terminal is not a write");
});
