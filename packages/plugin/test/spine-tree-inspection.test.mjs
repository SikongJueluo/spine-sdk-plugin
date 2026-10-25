import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../dist/deepseek-harness/extension.js";
import {
  DeepSeekHarnessInspection,
  DeepSeekHarnessSourceBindings,
  DomainDeepSeekHarnessRequestStore,
  MAX_CAPTURED_REQUEST_BYTES,
  MemoryDeepSeekHarnessRequestStore,
  SPINE_AUDIT_DOMAIN_SPEC,
  auditRequest,
  buildTreeView,
  freezeRequest,
  looksLikeLoopRequest,
  materializeDeepSeekHarnessContext,
  reconstructSpineTree,
  summarizeRequest,
} from "../dist/deepseek-harness/index.js";
import { createSpineRoutes, SPINE_REQUEST_PATH, SPINE_TREE_PATH } from "../../spine-tree/host/routes.js";

const THREAD = "thread-a";
const id = (ordinal) => ({ thread: THREAD, epoch: 0, ordinal });

function message(role, text, extra = {}) {
  return {
    id: extra.id ?? `${role}-${text}`,
    role,
    source: extra.source ?? (role === "user" ? { kind: "user" } : { kind: "model", provider: "p", model: "m" }),
    content: [{ type: "text", text }],
    ...extra,
  };
}

function planFor(count) {
  return {
    schema: "spine.context.plan.v2",
    thread: THREAD,
    epoch: 0,
    cells: Array.from({ length: count }, (_, index) =>
      index % 2 === 0
        ? { type: "source", source_id: id(index), labels: [] }
        : {
            type: "projection",
            projection_id: id(index),
            item: {
              MemorySlot: {
                Summary: { owner_node: [0], source: { start: 0, end: 0 }, body: `memory-${index}` },
              },
            },
          }),
  };
}

function freeze(overrides = {}) {
  return freezeRequest({
    sessionId: "session-1",
    sessionCreatedAt: 1,
    requestId: overrides.requestId ?? "request-1",
    capturedAt: overrides.capturedAt ?? 1_700_000_000_000,
    purpose: null,
    attempt: 1,
    planId: overrides.planId ?? null,
    request: {
      provider: "deepseek",
      model: "model-x",
      sessionId: "session-1",
      messages: overrides.messages ?? [],
      tools: overrides.tools ?? [{ name: "read", description: "read", parameters: {} }],
    },
    plan: overrides.plan ?? null,
    expected: overrides.expected ?? null,
    planError: overrides.planError ?? null,
  });
}

const expectedUser = message("user", "hello", { source: { kind: "user" } });

test("tree layout follows parent links and marks the cursor path", () => {
  const projection = {
    nodes: [
      { id: [0], parent: null, children: [[0, 1], [0, 2]], kind: "RootEpoch", status: "Opened", summary: "root", memory: null, start: 0, end: null },
      { id: [0, 1], parent: [0], children: [[0, 1, 1]], kind: "Task", status: "Closed", summary: "closed work", memory: [], start: 1, end: 3 },
      { id: [0, 1, 1], parent: [0, 1], children: [], kind: "Task", status: "Live", summary: "live work", memory: [], start: 2, end: null },
      { id: [0, 2], parent: [0], children: [], kind: "Task", status: "Opened", summary: "sibling", memory: [], start: 3, end: null },
    ],
    cursor: [0, 1, 1],
    visible_context: [
      { Message: { message: { boundary: 0, role: "User", content: "x" }, user_anchor: null } },
      { MemorySlot: { Summary: { owner_node: [0, 1], source: { start: 0, end: 1 }, body: "m" } } },
    ],
    last_boundary: 3,
  };
  const view = buildTreeView(projection, { state: "live", evidence: "live", thread: THREAD, epoch: 0 });
  assert.deepEqual(view.nodes.map((node) => node.id), ["0", "0.1", "0.1.1", "0.2"]);
  assert.deepEqual(view.nodes.map((node) => node.depth), [0, 1, 2, 1]);
  assert.equal(view.cursorId, "0.1.1");
  assert.equal(view.nodes.find((node) => node.id === "0.1.1").onCursorPath, true);
  assert.equal(view.nodes.find((node) => node.id === "0.1").onCursorPath, true);
  assert.equal(view.nodes.find((node) => node.id === "0.2").onCursorPath, false);
  assert.equal(view.nodes.find((node) => node.id === "0.1.1").cursor, true);
  assert.deepEqual(view.counts, { nodes: 4, live: 1, opened: 2, closed: 1, compacted: 0, tasks: 3, memory: 0 });
  assert.deepEqual(view.visibleContext, { count: 2, kinds: { message: 1, "memory-summary": 1 } });
});

test("memory slots keep every returned slot in order", () => {
  const view = buildTreeView({
    nodes: [{
      id: [0], parent: null, children: [], kind: "RootEpoch", status: "Live", summary: "root",
      memory: [
        { User: { owner_node: [0], message: { boundary: 4, role: "User", content: "typed text" }, anchor: 1 } },
        { Summary: { owner_node: [0], source: { start: 0, end: 2 }, body: "summary body" } },
        {
          SpawnEvidence: {
            owner_node: [0], source: { start: 2, end: 3 },
            task: { summary: "task one", prompt: "do it" },
            outcome: "errored", diagnostic: "boom", execution_ref: "ref-1",
          },
        },
      ],
      start: 0, end: null,
    }],
    cursor: [0],
    visible_context: [],
    last_boundary: null,
  }, { state: "recovered", evidence: "reconstructed" });
  assert.equal(view.state, "recovered");
  assert.equal(view.evidence, "reconstructed");
  assert.deepEqual(view.nodes[0].memory.map((slot) => slot.kind), ["user", "summary", "spawn"]);
  assert.equal(view.nodes[0].memory[0].text, "typed text");
  assert.equal(view.nodes[0].memory[2].diagnostic, "boom");
});

test("a consistent request records the host layer without inventing differences", () => {
  const plan = planFor(2);
  const expected = [expectedUser, message("assistant", "done", { id: "assistant-1" })];
  const record = freeze({
    plan,
    expected,
    messages: [message("system", "you are helpful", { id: "sys" }), ...expected],
  });
  assert.equal(record.audit.status, "consistent");
  assert.equal(record.audit.hostLayer.leadingSystem, true);
  assert.equal(record.audit.hostLayer.systemMessages, 1);
  assert.equal(record.audit.differences.length, 0);
  assert.deepEqual(record.audit.planCells.map((cell) => cell.matchedRequestIndex), [1, 2]);
  const summary = summarizeRequest(record);
  assert.equal(summary.audit.status, "consistent");
  assert.equal(summary.messageCount, 3);
});

test("a planned message that never reaches the request is unexplained", () => {
  const expected = [expectedUser, message("assistant", "done", { id: "assistant-1" })];
  const record = freeze({
    plan: planFor(2),
    expected,
    messages: [message("system", "sys", { id: "sys" }), expectedUser],
  });
  assert.equal(record.audit.status, "unexplained");
  assert.equal(record.audit.differences.filter((diff) => diff.category === "missing-plan-message").length, 1);
});

test("same identity with rewritten content is a content difference", () => {
  const expected = [expectedUser];
  const rewritten = message("user", "hello, but different", { id: expectedUser.id, source: { kind: "user" } });
  const record = freeze({ plan: planFor(1), expected, messages: [rewritten] });
  assert.equal(record.audit.status, "unexplained");
  assert.equal(record.audit.differences[0].category, "content-changed");
});

test("an anchor-only rewrite is a known difference", () => {
  const expected = [expectedUser];
  const anchored = message("user", "[U3]\nhello", { id: expectedUser.id, source: { kind: "user" } });
  const record = freeze({ plan: planFor(1), expected, messages: [anchored] });
  assert.equal(record.audit.status, "known-differences");
  assert.equal(record.audit.differences[0].category, "anchor-presentation");
});

test("an anchor number change is a content error, not a known difference", () => {
  const planned = message("user", "[U1]\nhello", { id: "user-anchor", source: { kind: "user" } });
  const actual = message("user", "[U99]\nhello", { id: "user-anchor", source: { kind: "user" } });
  const record = freeze({ plan: planFor(1), expected: [planned], messages: [actual] });
  assert.equal(record.audit.status, "unexplained");
  assert.equal(record.audit.differences[0].category, "content-changed");
  assert.equal(
    record.audit.differences.some((difference) => difference.category === "anchor-presentation"),
    false,
  );
});

test("a missing anchor prefix remains a known presentation difference", () => {
  const planned = message("user", "[U1]\nhello", { id: "user-anchor", source: { kind: "user" } });
  const actual = message("user", "hello", { id: "user-anchor", source: { kind: "user" } });
  const record = freeze({ plan: planFor(1), expected: [planned], messages: [actual] });
  assert.equal(record.audit.status, "known-differences");
  assert.equal(record.audit.differences[0].category, "anchor-presentation");
});

test("anchor exceptions never apply to non-human or non-user messages", () => {
  const contextual = (text) => ({
    id: "context-1",
    role: "user",
    source: { kind: "contextual" },
    content: [{ type: "text", text }],
  });
  const contextRecord = freeze({
    plan: planFor(1),
    expected: [contextual("runtime context")],
    messages: [contextual("[U5]\nruntime context")],
  });
  assert.equal(contextRecord.audit.status, "unexplained");
  assert.equal(contextRecord.audit.differences[0].category, "content-changed");

  const assistant = (text) => message("assistant", text, { id: "assistant-anchor" });
  const assistantRecord = freeze({
    plan: planFor(1),
    expected: [assistant("[U1]\nanswer")],
    messages: [assistant("[U2]\nanswer")],
  });
  assert.equal(assistantRecord.audit.status, "unexplained");
  assert.equal(assistantRecord.audit.differences[0].category, "content-changed");
});

test("an unexpected model message is reported, not normalized away", () => {
  const expected = [expectedUser];
  const extra = message("assistant", "extra turn", { id: "assistant-extra" });
  const record = freeze({ plan: planFor(1), expected, messages: [expectedUser, extra] });
  assert.equal(record.audit.status, "unexplained");
  assert.equal(record.audit.differences.some((diff) => diff.category === "unexpected-request-message"), true);
});

test("tool pairing and tool-call identity are part of the comparison", () => {
  const call = {
    id: "assistant-call",
    role: "assistant",
    source: { kind: "model", provider: "p", model: "m" },
    content: [{ type: "tool-call", id: "call-1", name: "read", arguments: "{}" }],
  };
  const result = {
    id: "tool-result-1",
    role: "tool",
    source: { kind: "tool", callId: "call-1" },
    toolCallId: "call-1",
    content: [{ type: "text", text: "contents" }],
  };
  const consistent = freeze({ plan: planFor(2), expected: [call, result], messages: [call, result] });
  assert.equal(consistent.audit.status, "consistent");

  const wrongPair = { ...result, source: { kind: "tool", callId: "call-2" }, toolCallId: "call-2" };
  const broken = freeze({ plan: planFor(2), expected: [call, result], messages: [call, wrongPair] });
  assert.equal(broken.audit.status, "unexplained");
  assert.equal(broken.audit.differences[0].category, "content-changed");
});

test("duplicate messages are reported with their request index", () => {
  const expected = [expectedUser];
  const record = freeze({ plan: planFor(1), expected, messages: [expectedUser, expectedUser] });
  assert.equal(record.audit.status, "unexplained");
  const duplicate = record.audit.differences.find((diff) => diff.category === "duplicate");
  assert.equal(duplicate.requestIndex, 1);
});

test("missing plan and truncated evidence are insufficient, never green", () => {
  const noPlan = freeze({ messages: [expectedUser] });
  assert.equal(noPlan.audit.status, "insufficient");
  assert.equal(noPlan.audit.differences[0].category, "plan-unavailable");
  const audit = auditRequest({
    plan: planFor(1),
    expected: [expectedUser],
    actual: [expectedUser],
    truncated: true,
  });
  assert.equal(audit.status, "insufficient");
});

test("materialized project cells compare against the frozen request", () => {
  const bindings = new DeepSeekHarnessSourceBindings();
  bindings.bind(id(0), { message: expectedUser, origin: null });
  const plan = {
    schema: "spine.context.plan.v2",
    thread: THREAD,
    epoch: 0,
    cells: [
      { type: "source", source_id: id(0), labels: [] },
      {
        type: "projection",
        projection_id: id(1),
        item: {
          MemorySlot: { Summary: { owner_node: [0], source: { start: 0, end: 1 }, body: "remembered" } },
        },
      },
    ],
  };
  const context = {
    transactionId: null,
    contextPlan: plan,
    projection: { nodes: [], cursor: [0], visible_context: [], last_boundary: null },
  };
  const expected = materializeDeepSeekHarnessContext(context, bindings);
  assert.equal(expected.length, 2);
  const record = freeze({ plan, expected, messages: [message("system", "sys", { id: "sys" }), ...expected] });
  assert.equal(record.audit.status, "consistent");
  assert.equal(record.audit.planCells[1].label, "projection memory-summary");
  assert.equal(record.audit.planCells[1].matchedRequestIndex, 2);
});

test("request evidence survives a store reopen and is pruned by retention", async () => {
  const records = new Map();
  const domain = {
    table() {
      return {
        entries() { return records.entries(); },
        async put(key, value) { records.set(key, value); },
        async delete(key) { return records.delete(key); },
      };
    },
    async close() {},
  };
  const store = new DomainDeepSeekHarnessRequestStore(domain, 2);
  await store.append(freeze({ requestId: "a", capturedAt: 10, plan: planFor(1), expected: [expectedUser], messages: [expectedUser] }));
  await store.append(freeze({ requestId: "b", capturedAt: 20, plan: planFor(1), expected: [expectedUser], messages: [expectedUser] }));
  await store.append(freeze({ requestId: "c", capturedAt: 30, plan: planFor(1), expected: [expectedUser], messages: [expectedUser] }));
  assert.equal(store.count("session-1"), 2);
  assert.equal(store.detail("session-1", "a"), null);
  assert.equal(store.detail("session-1", "c").requestId, "c");

  const reopened = new DomainDeepSeekHarnessRequestStore(domain, 2);
  assert.equal(reopened.summaries("session-1").length, 2);
  assert.equal(reopened.detail("session-1", "b").audit.status, "consistent");
});

test("evidence written before planId existed still reopens beside new records", async () => {
  const records = new Map();
  const domain = {
    table() {
      return {
        entries() { return records.entries(); },
        async put(key, value) { records.set(key, value); },
        async delete(key) { return records.delete(key); },
      };
    },
    async close() {},
  };
  const current = freeze({
    requestId: "old",
    capturedAt: 10,
    plan: planFor(1),
    expected: [expectedUser],
    messages: [expectedUser],
    planId: "plan-1",
  });
  const legacy = { ...current };
  delete legacy.planId;
  records.set("old-v1-record", legacy);

  const store = new DomainDeepSeekHarnessRequestStore(domain, 10);
  assert.equal(store.summaries("session-1").length, 1);
  assert.equal(store.detail("session-1", "old").planId, null);

  await store.append(freeze({
    requestId: "new",
    capturedAt: 20,
    plan: planFor(1),
    expected: [expectedUser],
    messages: [expectedUser],
    planId: "plan-9",
  }));

  const reopened = new DomainDeepSeekHarnessRequestStore(domain, 10);
  assert.equal(reopened.summaries("session-1").length, 2);
  assert.equal(reopened.detail("session-1", "old").planId, null);
  assert.equal(reopened.detail("session-1", "new").planId, "plan-9");
});

test("the in-memory evidence store mirrors the durable contract", async () => {
  const store = new MemoryDeepSeekHarnessRequestStore(1);
  await store.append(freeze({ requestId: "a", capturedAt: 1, messages: [expectedUser] }));
  await store.append(freeze({ requestId: "b", capturedAt: 2, messages: [expectedUser] }));
  assert.equal(store.count("session-1"), 1);
  assert.equal(store.summaries("session-1")[0].id, "b");
});

test("the audit domain declares the request table", () => {
  assert.equal(SPINE_AUDIT_DOMAIN_SPEC.name, "spine_dsh_audit");
  assert.equal(SPINE_AUDIT_DOMAIN_SPEC.layout, "per-record");
  assert.ok(SPINE_AUDIT_DOMAIN_SPEC.tables.requests);
});

test("loop requests are recognized structurally", () => {
  const request = {
    provider: "p",
    model: "m",
    sessionId: "session-1",
    messages: [message("system", "sys"), expectedUser],
    tools: [],
  };
  assert.equal(looksLikeLoopRequest(request, "session-1"), true);
  assert.equal(looksLikeLoopRequest({ ...request, purpose: "session-title" }, "session-1"), false);
  assert.equal(looksLikeLoopRequest({ ...request, sessionId: "other" }, "session-1"), false);
  assert.equal(looksLikeLoopRequest({ ...request, system: "one-shot" }, "session-1"), false);
  assert.equal(looksLikeLoopRequest({ ...request, messages: [] }, "session-1"), false);
});

test("a tool-continuation request is bound to the committed plan, not the previous preview", async () => {
  const session = {
    id: "session-step",
    header: { createdAt: 7 },
    seq: 4,
    snapshotEvents: () => [],
  };
  const store = new MemoryDeepSeekHarnessRequestStore();
  const inspection = new DeepSeekHarnessInspection({
    ledger: async () => ({ findSession: async () => undefined, entries: async () => [] }),
    requests: async () => store,
    inspectSession: async () => ({ events: [], createdAt: 7 }),
    runtimeFactory: () => ({ client: {}, dispose() {} }),
    now: () => 5_000,
  });
  const projection = {
    nodes: [{ id: [0], parent: null, children: [], kind: "RootEpoch", status: "Live", summary: "root", memory: null, start: 0, end: null }],
    cursor: [0],
    visible_context: [],
    last_boundary: null,
  };
  const planOne = planFor(1);
  const planTwo = planFor(2);
  const first = message("user", "first", { source: { kind: "user" } });
  const second = message("assistant", "second", { id: "assistant-2" });
  const materialized = [];
  inspection.attach(session);
  inspection.reportContext(session, { transactionId: null, contextPlan: planOne, projection }, "preview");
  const one = inspection.captureRequest(session, {
    provider: "deepseek",
    model: "model-x",
    sessionId: "session-step",
    messages: [message("system", "sys"), first],
    tools: [],
  }, (plan) => {
    materialized.push(plan.cells.length);
    return plan.cells.length === 1 ? [first] : [first, second];
  });
  assert.equal(one.attempt, 1);
  assert.equal(one.planId, "plan-1");
  assert.equal(one.audit.status, "consistent");

  // Ordinary continuation: no new input, hence no preview before the request.
  inspection.reportContext(session, { transactionId: "tx-1", contextPlan: planTwo, projection }, "commit");
  const two = inspection.captureRequest(session, {
    provider: "deepseek",
    model: "model-x",
    sessionId: "session-step",
    messages: [message("system", "sys"), first, second],
    tools: [],
  }, (plan) => {
    materialized.push(plan.cells.length);
    return plan.cells.length === 1 ? [first] : [first, second];
  });
  assert.deepEqual(materialized, [1, 2], "each request materializes the plan current at its own time");
  assert.equal(two.planId, "plan-2");
  assert.equal(two.attempt, 1, "a new step restarts the attempt count");
  assert.equal(two.audit.planCells.length, 2);
  assert.equal(two.audit.status, "consistent");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.count("session-step"), 2);
});

test("retries inside one step keep the same plan and increment the attempt", () => {
  const session = {
    id: "session-retry",
    header: { createdAt: 7 },
    seq: 4,
    snapshotEvents: () => [],
  };
  const store = new MemoryDeepSeekHarnessRequestStore();
  const inspection = new DeepSeekHarnessInspection({
    ledger: async () => ({ findSession: async () => undefined, entries: async () => [] }),
    requests: async () => store,
    inspectSession: async () => ({ events: [], createdAt: 7 }),
    runtimeFactory: () => ({ client: {}, dispose() {} }),
    now: () => 6_000,
  });
  const projection = {
    nodes: [{ id: [0], parent: null, children: [], kind: "RootEpoch", status: "Live", summary: "root", memory: null, start: 0, end: null }],
    cursor: [0],
    visible_context: [],
    last_boundary: null,
  };
  const first = message("user", "first", { source: { kind: "user" } });
  inspection.attach(session);
  inspection.reportContext(session, { transactionId: null, contextPlan: planFor(1), projection }, "preview");
  const request = { provider: "p", model: "m", sessionId: "session-retry", messages: [message("system", "sys"), first], tools: [] };
  const one = inspection.captureRequest(session, request, () => [first]);
  const two = inspection.captureRequest(session, request, () => [first]);
  assert.equal(one.attempt, 1);
  assert.equal(two.attempt, 2);
  assert.equal(one.planId, two.planId);
});

test("a completed persist becomes visible on the next poll without another lifecycle event", async () => {
  const session = {
    id: "session-late",
    header: { createdAt: 9 },
    seq: 2,
    snapshotEvents: () => [],
  };
  const records = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = {
    async append(record) {
      await gate;
      records.push(record);
    },
    summaries() {
      return records.map((record) => summarizeRequest(record));
    },
    detail(sessionId, requestId) {
      return records.find((record) => record.requestId === requestId) ?? null;
    },
    count() {
      return records.length;
    },
    async close() {},
  };
  const inspection = new DeepSeekHarnessInspection({
    ledger: async () => ({ findSession: async () => undefined, entries: async () => [] }),
    requests: async () => store,
    inspectSession: async () => ({ events: [], createdAt: 9 }),
    runtimeFactory: () => ({ client: {}, dispose() {} }),
    now: () => 7_000,
  });
  const projection = {
    nodes: [{ id: [0], parent: null, children: [], kind: "RootEpoch", status: "Live", summary: "root", memory: null, start: 0, end: null }],
    cursor: [0],
    visible_context: [],
    last_boundary: null,
  };
  const first = message("user", "first", { source: { kind: "user" } });
  inspection.attach(session);
  inspection.reportContext(session, { transactionId: null, contextPlan: planFor(1), projection }, "preview");
  inspection.captureRequest(session, {
    provider: "p",
    model: "m",
    sessionId: "session-late",
    messages: [message("system", "sys"), first],
    tools: [],
  }, () => [first]);

  const before = await inspection.view("session-late");
  assert.equal(before.requests.length, 0);
  assert.equal(before.revision, 2);

  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await inspection.view("session-late", { since: before.revision });
  assert.equal(after.unchanged, undefined);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.requests.length, 1);
  const fresh = await inspection.view("session-late");
  assert.equal(fresh.requests.length, 1);
});

test("same content in a different position is an order anomaly, not an anchor difference", () => {
  const first = message("user", "first", { id: "first", source: { kind: "user" } });
  const second = message("user", "second", { id: "second", source: { kind: "user" } });
  const record = freeze({
    plan: planFor(2),
    expected: [first, second],
    messages: [second, first],
  });
  assert.equal(record.audit.status, "unexplained");
  assert.equal(
    record.audit.differences.some((difference) => difference.category === "anchor-presentation"),
    false,
  );
  assert.equal(
    record.audit.differences.filter((difference) => difference.category === "order").length,
    1,
  );
});

test("evidence never exceeds its declared storage bound", () => {
  const hugeCall = freeze({
    requestId: "huge-call",
    plan: planFor(1),
    expected: [],
    messages: [{
      id: "assistant-huge",
      role: "assistant",
      source: { kind: "model", provider: "p", model: "m" },
      content: [{ type: "tool-call", id: "call", name: "read", arguments: "x".repeat(3 * 1024 * 1024) }],
    }],
  });
  assert.equal(hugeCall.truncated, true);
  assert.equal(hugeCall.audit.status, "insufficient");
  assert.ok(hugeCall.audit.differences.some((difference) => difference.category === "truncated"));
  const hugeSize = Buffer.byteLength(JSON.stringify(hugeCall));
  assert.ok(hugeSize <= MAX_CAPTURED_REQUEST_BYTES, `huge call record is ${hugeSize} bytes`);
  assert.ok(Math.abs(hugeCall.bytes - hugeSize) < 32);

  const cells = Array.from({ length: 600 }, (_, index) => ({
    type: "projection",
    projection_id: id(index),
    item: {
      MemorySlot: {
        Summary: { owner_node: [0], source: { start: 0, end: 1 }, body: "y".repeat(20_000) },
      },
    },
  }));
  const hugePlan = freeze({
    requestId: "huge-plan",
    plan: { schema: "spine.context.plan.v2", thread: THREAD, epoch: 0, cells },
    expected: [],
    messages: [],
  });
  assert.equal(hugePlan.truncated, true);
  const planSize = Buffer.byteLength(JSON.stringify(hugePlan));
  assert.ok(planSize <= MAX_CAPTURED_REQUEST_BYTES, `huge plan record is ${planSize} bytes`);
  assert.ok(Math.abs(hugePlan.bytes - planSize) < 32);
});

test("the inspection service serves revisions, evidence and details without touching Spine", async () => {
  const session = {
    id: "session-1",
    header: { createdAt: 5 },
    seq: 3,
    snapshotEvents: () => [],
  };
  const store = new MemoryDeepSeekHarnessRequestStore();
  let clock = 1_000;
  const inspection = new DeepSeekHarnessInspection({
    ledger: async () => ({
      findSession: async () => undefined,
      entries: async () => [],
    }),
    requests: async () => store,
    inspectSession: async () => ({ events: [], createdAt: 5 }),
    runtimeFactory: () => ({ client: {}, dispose() {} }),
    now: () => clock,
  });
  inspection.attach(session);
  const projection = {
    nodes: [{ id: [0], parent: null, children: [], kind: "RootEpoch", status: "Live", summary: "root", memory: null, start: 0, end: null }],
    cursor: [0],
    visible_context: [],
    last_boundary: null,
  };
  inspection.reportContext(session, {
    transactionId: null,
    contextPlan: planFor(1),
    projection,
  }, "preview");

  const first = await inspection.view("session-1");
  assert.equal(first.revision, 2);
  assert.equal(first.spine.state, "live");
  assert.equal(first.spine.nodes[0].summary, "root");
  const unchanged = await inspection.view("session-1", { since: first.revision });
  assert.deepEqual(unchanged, { revision: first.revision, unchanged: true });

  clock += 10;
  const record = inspection.captureRequest(session, {
    provider: "deepseek",
    model: "model-x",
    sessionId: "session-1",
    messages: [message("system", "sys"), expectedUser],
    tools: [],
  }, () => [expectedUser]);
  assert.equal(record.audit.status, "consistent");
  await new Promise((resolve) => setTimeout(resolve, 5));

  const detail = await inspection.request("session-1", record.requestId);
  assert.equal(detail.ok, true);
  assert.equal(detail.detail.record.requestId, record.requestId);
  assert.equal(detail.detail.summary.audit.status, "consistent");

  const moved = await inspection.view("session-1", { since: first.revision });
  assert.equal(moved.unchanged, undefined);
  assert.equal(moved.revision, first.revision + 1);
  assert.equal(moved.requests.length, 1);
  await inspection.close();
});

test("the extension provides the inspection service over a cold Session", async () => {
  const listeners = new Map();
  const disposers = [];
  let provided;
  const ctx = {
    sessions: {},
    subagents: {},
    tools: { register: () => () => {} },
    storageDomain: {
      open: async () => ({
        table: () => ({
          entries: () => new Map()[Symbol.iterator](),
          put: async () => {},
          delete: async () => false,
        }),
        close: async () => {},
      }),
    },
    get(name) {
      if (name === "sessionController") {
        return {
          inspect: async () => ({ meta: { createdAt: 5 }, events: [] }),
        };
      }
      return undefined;
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => {};
    },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === "function") disposers.push(dispose);
    },
    provide(name, value) {
      provided = { name, value };
      return () => {};
    },
  };
  apply(ctx, {});
  assert.equal(provided.name, "spineInspection");
  assert.equal(provided.value.schema, "spine.dsh.inspect.v1");
  assert.ok(listeners.has("llm/stream"));
  assert.ok(listeners.has("agent/pre-step"));

  const view = await provided.value.view("cold-session");
  assert.equal(view.revision, 1);
  assert.equal(view.host.available, true);
  assert.equal(view.spine.state, "unavailable");
  assert.match(view.spine.note, /no Spine sampling archive/);
  const unchanged = await provided.value.view("cold-session", { since: 1 });
  assert.deepEqual(unchanged, { revision: 1, unchanged: true });

  const evidence = await provided.value.request("cold-session", "missing");
  assert.equal(evidence.ok, false);
  assert.match(evidence.reason, /No captured evidence/);
  for (const dispose of disposers) dispose();
});

test("historical reconstruction reports the missing archive instead of a fake tree", async () => {
  let replayCalls = 0;
  const result = await reconstructSpineTree({
    sessionId: "session-1",
    sessionCreatedAt: 1,
    events: [],
    ledger: async () => ({
      entries: async () => [],
    }),
    runtimeFactory: () => {
      replayCalls += 1;
      return { client: { execute: async () => { throw new Error("must not run"); } }, dispose() {} };
    },
  });
  assert.equal(result.projection, null);
  assert.match(result.reason, /no Spine sampling archive/);
  assert.equal(replayCalls, 0);
});

test("routes answer explicitly when the Spine host is absent", async () => {
  const routes = createSpineRoutes({ service: () => undefined, now: () => 42 });
  const tree = await routes.tree(new Request(`http://host${SPINE_TREE_PATH}?sessionId=session-1`));
  assert.equal(tree.status, 200);
  const payload = await tree.json();
  assert.equal(payload.host.available, false);
  assert.equal(payload.host.reason, "spine-host-inactive");
  assert.equal(payload.revision, 0);
  assert.equal(payload.spine.state, "unavailable");

  const missing = await routes.tree(new Request(`http://host${SPINE_TREE_PATH}`));
  assert.equal(missing.status, 400);
  const detail = await routes.request(new Request(`http://host${SPINE_REQUEST_PATH}?sessionId=session-1`));
  assert.equal(detail.status, 400);
});

test("routes forward revision and request detail unchanged", async () => {
  const view = { schema: "spine.dsh.view.v1", revision: 7, unchanged: true };
  const detail = { ok: true, reason: null, detail: { schema: "spine.dsh.request.v1" } };
  const routes = createSpineRoutes({
    service: () => ({
      view: async (sessionId, options) => {
        assert.equal(sessionId, "session-1");
        assert.deepEqual(options, { since: 6 });
        return view;
      },
      request: async (sessionId, requestId) => {
        assert.equal(requestId, "req-1");
        return detail;
      },
    }),
  });
  const tree = await routes.tree(new Request(`http://host${SPINE_TREE_PATH}?sessionId=session-1&since=6`));
  assert.deepEqual(await tree.json(), view);
  const item = await routes.request(new Request(`http://host${SPINE_REQUEST_PATH}?sessionId=session-1&id=req-1`));
  assert.deepEqual(await item.json(), detail);
  assert.equal(tree.headers.get("cache-control"), "no-store");
});
