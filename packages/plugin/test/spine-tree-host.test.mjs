import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryDeepSeekHarnessRequestStore,
  leaseSharedRequestStore,
  leaseSharedStore,
  normalizedRetention,
} from "../dist/deepseek-harness/index.js";
import { createSpineInspectionHost } from "../../spine-tree/host/broker.js";
import {
  createSpineRoutes,
  SPINE_REQUEST_PATH,
  SPINE_TREE_PATH,
} from "../../spine-tree/host/routes.js";
import * as host from "../../spine-tree/index.js";

function contribution(overrides = {}) {
  return {
    view: async () => ({ schema: "spine.dsh.view.v1", revision: 1 }),
    request: async () => ({ ok: true, reason: null, detail: null }),
    ...overrides,
  };
}

test("the Host broker names no inspection when no preset contributed one", async () => {
  const broker = createSpineInspectionHost();
  assert.equal(broker.schema, host.SPINE_INSPECTION_HOST_SCHEMA);
  assert.deepEqual(broker.describe(), []);
  assert.deepEqual(await broker.select("session-1"), { kind: "none", sources: 0 });
});

test("a Session without a preset header is not re-read on every poll", async () => {
  let reads = 0;
  const broker = createSpineInspectionHost({
    presetOf: async () => {
      reads += 1;
      return undefined;
    },
  });
  broker.register(contribution());
  await broker.select("session-1");
  await broker.select("session-1");
  assert.equal(reads, 1, "a missing identity is cached briefly");
});

test("the Host broker returns the only contribution with a source generation", async () => {
  const broker = createSpineInspectionHost();
  const only = contribution({ presetId: "personal" });
  const release = broker.register(only);
  const description = broker.describe();
  assert.equal(description.length, 1);
  assert.match(description[0].source, /^spine-source-[a-z0-9]+-[a-z0-9]+-\d+$/);
  const selection = await broker.select("session-1");
  assert.equal(selection.kind, "ok");
  assert.equal(selection.contribution, only);
  assert.equal(selection.source, description[0].source);
  release();
  release();
  assert.equal(broker.describe().length, 0);
});

test("each registration gets a distinct source generation", async () => {
  const broker = createSpineInspectionHost();
  const first = contribution({ id: "first" });
  const second = contribution({ id: "second" });
  broker.register(first);
  broker.register(second);
  const sources = Object.fromEntries(broker.describe().map((entry) => [entry.id, entry.source]));
  assert.notEqual(sources.first, sources.second);

  broker.register(first)();
  assert.equal(broker.describe().length, 2, "a duplicate registration is a no-op");

  const release = broker.register(contribution({ id: "third" }));
  const thirdSource = broker.describe().find((entry) => entry.id === "third")?.source;
  release();
  broker.register(contribution({ id: "third" }));
  const freshSource = broker.describe().find((entry) => entry.id === "third")?.source;
  assert.notEqual(freshSource, thirdSource, "re-registration forces a new baseline");
});

test("a broker reload cannot reuse a source generation", () => {
  const first = createSpineInspectionHost();
  first.register(contribution({ id: "before-reload" }));
  const second = createSpineInspectionHost();
  second.register(contribution({ id: "after-reload" }));
  assert.notEqual(first.describe()[0].source, second.describe()[0].source);
});

test("one contribution does not serve a Session recorded under another preset", async () => {
  const broker = createSpineInspectionHost({ presetOf: async () => "work" });
  broker.register(contribution({ presetId: "personal" }));
  assert.deepEqual(await broker.select("session-1"), { kind: "none", sources: 1 });

  const unknown = createSpineInspectionHost({ presetOf: async () => "work" });
  unknown.register(contribution());
  const selection = await unknown.select("session-1");
  assert.equal(selection.kind, "ok", "an unidentified single source is the only candidate");
});

test("a live Session selects its exact revision, not another preset", async () => {
  const broker = createSpineInspectionHost({ presetOf: async () => "work" });
  const personal = contribution({ presetId: "personal", hasLive: () => false });
  const work = contribution({ presetId: "work", hasLive: () => true });
  broker.register(personal);
  broker.register(work);
  const selection = await broker.select("session-1");
  assert.equal(selection.kind, "ok");
  assert.equal(selection.contribution, work);
});

test("a historical Session is matched by its durable preset identity", async () => {
  let reads = 0;
  const broker = createSpineInspectionHost({
    presetOf: async () => {
      reads += 1;
      return "work";
    },
  });
  const personal = contribution({ presetId: () => "personal" });
  const work = contribution({ presetId: "work" });
  broker.register(personal);
  broker.register(work);
  const selection = await broker.select("session-1");
  assert.equal(selection.kind, "ok");
  assert.equal(selection.contribution, work);
  await broker.select("session-1");
  assert.equal(reads, 1, "the immutable stored header is read once per broker");
});

test("a historical Session falls back to evidence ownership", async () => {
  const broker = createSpineInspectionHost();
  const owner = contribution({ owns: async () => true });
  const other = contribution({ owns: async () => false });
  broker.register(owner);
  broker.register(other);
  const selection = await broker.select("session-1");
  assert.equal(selection.kind, "ok");
  assert.equal(selection.contribution, owner);
});

test("two different preset sources with equal evidence are reported, never merged", async () => {
  const broker = createSpineInspectionHost({ presetOf: async () => undefined });
  broker.register(contribution({ presetId: "personal", owns: async () => true }));
  broker.register(contribution({ presetId: "work", owns: async () => true }));
  assert.deepEqual(await broker.select("session-1"), {
    kind: "ambiguous",
    sources: 2,
    presets: ["personal", "work"],
  });
});

test("a retired revision and its replacement share the standing revision", async () => {
  const broker = createSpineInspectionHost({ presetOf: async () => "personal" });
  const retired = contribution({ presetId: "personal", owns: async () => false });
  const standing = contribution({ presetId: "personal", owns: async () => false });
  broker.register(retired);
  broker.register(standing);
  const selection = await broker.select("session-1");
  assert.equal(selection.kind, "ok");
  assert.equal(selection.contribution, standing);
});

test("no evidence among several preset sources is an explicit none, not a guess", async () => {
  const broker = createSpineInspectionHost({ presetOf: async () => "other" });
  broker.register(contribution({ presetId: "personal" }));
  broker.register(contribution({ presetId: "work" }));
  assert.deepEqual(await broker.select("session-1"), { kind: "none", sources: 2 });
});

test("broker probes never let a contribution failure become data", async () => {
  const broker = createSpineInspectionHost({
    presetOf: async () => {
      throw new Error("unreadable log");
    },
  });
  const throwing = contribution({
    presetId: () => {
      throw new Error("bad contribution");
    },
    hasLive: () => {
      throw new Error("bad live probe");
    },
    owns: async () => {
      throw new Error("bad owner probe");
    },
  });
  const quiet = contribution({ owns: async () => false });
  broker.register(throwing);
  broker.register(quiet);
  assert.deepEqual(await broker.select("session-1"), { kind: "none", sources: 2 });
});

test("a contribution must expose the read methods", () => {
  const broker = createSpineInspectionHost();
  assert.throws(() => broker.register({}), /must implement view/);
  assert.throws(() => broker.register({ view() {} }), /must implement request/);
  assert.throws(() => broker.register({ view() {}, request() {}, hasLive: true }), /hasLive/);
});

test("routes state why no inspection is available", async () => {
  const empty = createSpineRoutes({ service: () => createSpineInspectionHost(), now: () => 42 });
  const emptyTree = await empty.tree(new Request(`http://host${SPINE_TREE_PATH}?sessionId=s`));
  const emptyPayload = await emptyTree.json();
  assert.equal(emptyPayload.host.available, false);
  assert.equal(emptyPayload.host.reason, "spine-preset-inactive");
  assert.match(emptyPayload.host.message, /No Spine-enabled preset is contributing inspection data/);

  const two = createSpineInspectionHost();
  two.register(contribution({ presetId: "personal" }));
  two.register(contribution({ presetId: "work" }));
  const unmatched = createSpineRoutes({ service: () => two, now: () => 42 });
  const unmatchedPayload = await (await unmatched.tree(
    new Request(`http://host${SPINE_TREE_PATH}?sessionId=s`),
  )).json();
  assert.equal(unmatchedPayload.host.reason, "spine-preset-inactive");
  assert.match(unmatchedPayload.host.message, /No active Spine-enabled preset provides/);

  const matching = createSpineInspectionHost({ presetOf: async () => undefined });
  matching.register(contribution({ presetId: "personal", owns: async () => true }));
  matching.register(contribution({ presetId: "work", owns: async () => true }));
  const ambiguousRoutes = createSpineRoutes({ service: () => matching, now: () => 42 });
  const ambiguousPayload = await (await ambiguousRoutes.tree(
    new Request(`http://host${SPINE_TREE_PATH}?sessionId=s`),
  )).json();
  assert.equal(ambiguousPayload.host.reason, "spine-source-ambiguous");
  assert.match(ambiguousPayload.host.message, /personal, work/);
  assert.match(ambiguousPayload.host.message, /refusing to merge/);

  const failed = createSpineRoutes({
    service: () => ({ select: async () => { throw new Error("boom"); } }),
    now: () => 42,
  });
  const failedPayload = await (await failed.tree(
    new Request(`http://host${SPINE_TREE_PATH}?sessionId=s`),
  )).json();
  assert.equal(failedPayload.host.reason, "inspection-failed");
  assert.match(failedPayload.host.message, /boom/);

  const detail = await (await empty.request(
    new Request(`http://host${SPINE_REQUEST_PATH}?sessionId=s&id=r`),
  )).json();
  assert.equal(detail.ok, false);
  assert.match(detail.reason, /spine-preset-inactive/);
});

test("shared stores are keyed by facility and reference counted", async () => {
  const facility = {};
  let opens = 0;
  let closes = 0;
  const open = async () => {
    opens += 1;
    return { close: async () => { closes += 1; } };
  };
  const first = leaseSharedStore(facility, "domain", open);
  const second = leaseSharedStore(facility, "domain", open);
  assert.equal(opens, 0, "the handle opens lazily");
  const one = await first.store;
  const two = await second.store;
  assert.equal(one, two);
  assert.equal(opens, 1, "one domain handle serves both leases");
  await first.release();
  await first.release();
  assert.equal(closes, 0, "the handle stays open while one lease remains");
  await second.release();
  assert.equal(closes, 1);

  const other = leaseSharedStore({}, "domain", open);
  await other.store;
  assert.equal(opens, 2, "a different storage facility gets its own handle");
  await other.release();
});

test("a failed shared open is not retained", async () => {
  const facility = {};
  let attempts = 0;
  const store = { close: async () => {} };
  const first = leaseSharedStore(facility, "domain", async () => {
    attempts += 1;
    throw new Error("open failed");
  });
  await assert.rejects(first.store, /open failed/);
  await first.release();
  const second = leaseSharedStore(facility, "domain", async () => {
    attempts += 1;
    return store;
  });
  assert.equal(await second.store, store);
  assert.equal(attempts, 2);
  await second.release();
});

test("a lease taken while the shared store closes reopens after it", async () => {
  const facility = {};
  let opens = 0;
  let closes = 0;
  const open = async () => {
    opens += 1;
    return { close: async () => { closes += 1; } };
  };
  const first = leaseSharedStore(facility, "domain", open);
  const before = await first.store;
  const releasing = first.release();
  const second = leaseSharedStore(facility, "domain", open);
  const after = await second.store;
  assert.notEqual(after, before, "the closing generation is not handed to a new lease");
  assert.equal(opens, 2);
  await releasing;
  assert.equal(closes, 1);
  await second.release();
  assert.equal(closes, 2);
});

test("a shared request store keeps the largest requested retention", async () => {
  const facility = {};
  const open = async (retention) => new MemoryDeepSeekHarnessRequestStore(retention);
  const low = leaseSharedRequestStore(facility, open, 2);
  const high = leaseSharedRequestStore(facility, open, 5);
  const store = await low.store;
  assert.equal(store, await high.store);
  for (let index = 0; index < 5; index += 1) {
    await store.append({
      sessionId: "session-1",
      requestId: `request-${index}`,
      capturedAt: index,
      attempt: 0,
    });
  }
  assert.equal(store.count("session-1"), 5);
  assert.equal(normalizedRetention(0), 1);
  assert.equal(normalizedRetention(Number.NaN), 1);
  assert.equal(normalizedRetention(3.9), 3);
  await low.release();
  await high.release();
});

test("the preset and Host halves agree on the broker service name", async () => {
  const inspection = await import("../dist/deepseek-harness/inspection.js");
  assert.equal(host.SPINE_INSPECTION_HOST_SERVICE, inspection.SPINE_INSPECTION_HOST_SERVICE);
  assert.equal(host.SPINE_INSPECTION_HOST_SERVICE, "spineInspectionHost");
});
