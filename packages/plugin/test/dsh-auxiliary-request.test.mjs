// Regression seam: an auxiliary model call that borrows the Session id for
// routing (the auto-permit approval judge) must pass through `llm/stream`
// without joining the main sampling transaction.
//
// The mount below is the real `apply()` wiring: real SessionStore (so real
// `session/event` delivery), the real Spine runtime, and memory-backed durable
// domains. Only the Host `llm/stream` waterfall is replaced by direct hook
// invocation, which is exactly what the waterfall does.
import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";

import { apply } from "../dist/deepseek-harness/extension.js";

const LEDGER_DOMAIN = "spine_dsh_ledger";
const AUDIT_DOMAIN = "spine_dsh_audit";

function text(value) {
  return [{ type: "text", text: value }];
}

function user(id, value) {
  return { id, role: "user", source: { kind: "user" }, content: text(value) };
}

function assistant(id, value, callId) {
  const content = text(value);
  if (callId !== undefined) {
    content.push({ type: "tool-call", id: callId, name: "bash", arguments: "{}" });
  }
  return { id, role: "assistant", source: { kind: "model", provider: "test", model: "test" }, content };
}

function toolResult(id, callId, value) {
  return {
    id,
    role: "tool",
    source: { kind: "tool", callId },
    toolCallId: callId,
    isError: false,
    content: text(value),
  };
}

function systemMessage(value = "SYSTEM") {
  return { id: "system-1", role: "system", source: { kind: "system-prompt" }, content: text(value) };
}

/** Freeze a value the way the loop freezes the request it assembles. */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

/**
 * The request the agent loop assembles: no `system`, the prompt as the leading
 * system message, and the whole request deep-frozen. The clone keeps the frozen
 * copy from becoming a session message identity.
 */
function loopRequest(session, messages) {
  return deepFreeze({
    sessionId: session.id,
    provider: "test",
    model: "test",
    messages: messages.map((message) => structuredClone(message)),
    tools: [],
  });
}

/** The shape auto-permit's judge builds: one-shot `system` + user evidence. */
function auxiliaryRequest(session, evidence = "approval evidence") {
  return {
    sessionId: session.id,
    provider: "judge",
    model: "judge",
    system: "approval policy",
    messages: [{ role: "user", content: text(evidence) }],
    maxTokens: 64,
  };
}

function mount(config) {
  const ctx = new Context();
  ctx.on("session/flush", () => {});
  const store = new SessionStore(ctx);
  const hooks = new Map();
  const effects = [];
  const domains = new Map();
  apply({
    sessions: store,
    storageDomain: {
      async open(spec) {
        const tables = new Map();
        domains.set(spec.name, tables);
        return {
          table(name) {
            const rows = tables.get(name) ?? new Map();
            tables.set(name, rows);
            return {
              entries: () => rows.entries(),
              put: async (key, value) => { rows.set(key, value); },
              delete: async (key) => rows.delete(key),
            };
          },
          async close() {},
        };
      },
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 500 },
    subagents: {},
    get: () => undefined,
    on(name, listener) {
      hooks.set(name, listener);
      // The extension's session observer must receive the real Session events.
      if (name === "session/event") ctx.on(name, listener);
      return () => {};
    },
    effect: (callback) => { effects.push(callback); },
    inject() {},
  }, config);
  return {
    ctx,
    store,
    hooks,
    domains,
    stream: (request, next) => hooks.get("llm/stream")(request, next),
    async dispose() {
      for (const callback of effects) {
        const cleanup = callback();
        if (typeof cleanup === "function") await cleanup();
      }
      await ctx.fiber.dispose();
    },
  };
}

async function drain(iterable) {
  for await (const _chunk of iterable) { /* consume */ }
}

function finish(reason) {
  return (async function* finishStream() {
    yield { type: "finish", reason };
  })();
}

function archiveTypes(domains) {
  const counts = new Map();
  const rows = domains.get(LEDGER_DOMAIN)?.get("entries");
  if (rows === undefined) return counts;
  for (const [, value] of rows) {
    const type = value?.archive?.record?.type;
    if (typeof type === "string") counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

function auditRecords(domains) {
  const rows = domains.get(AUDIT_DOMAIN)?.get("requests");
  return rows === undefined ? [] : [...rows.values()];
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/**
 * Drive one real step through approval, then the tool continuation.
 *
 * The approval judge call happens while the main sampling is still active
 * (the tool waits for approval), which is the faulting shape.
 */
async function runApprovalScenario(config) {
  const harness = mount(config);
  const session = harness.store.create(`aux-${config.inspect === false ? "cold" : "live"}`);
  const preStep = harness.hooks.get("agent/pre-step");
  const input = user("u1", "list the workspace");

  session.append("turn/start", { turn: 1 });
  const decision = await preStep(
    { agent: { session } },
    async () => ({ kind: "enter", messages: [input] }),
  );
  assert.equal(decision.kind, "enter");
  session.append("step/start", { turn: 1, step: 1 });
  session.append("user/message", input, { surfaceOp: "append" });

  const first = loopRequest(session, [systemMessage(), input]);
  await drain(harness.stream(first, () => finish({ kind: "tool-calls" })));

  // The model asks for an approval-gated tool, so the step stays open and the
  // main sampling remains active while approval is resolved.
  session.append("assistant/message", {
    turn: 1,
    step: 1,
    message: assistant("a1", "run the command", "call-1"),
    usage: { inputTokens: 7, outputTokens: 3 },
    stream: [],
  }, { surfaceOp: "append" });
  session.append("tool/call", {
    turn: 1,
    step: 1,
    callId: "call-1",
    name: "bash",
    arguments: { command: "ls" },
  });

  let auxiliaryRuns = 0;
  const auxiliaryProvider = () => {
    auxiliaryRuns += 1;
    return finish({ kind: "stop" });
  };

  // The judge call reaches its own provider instead of the main sampling gate.
  await drain(harness.stream(auxiliaryRequest(session), auxiliaryProvider));
  assert.equal(auxiliaryRuns, 1, "the approval call must reach its own provider");

  // A failing judge call belongs to the producer, not to the main lifecycle.
  await assert.rejects(
    drain(harness.stream(auxiliaryRequest(session, "second opinion"), () => {
      throw new Error("judge provider unavailable");
    })),
    /judge provider unavailable/,
  );

  // Approval lands, the tool succeeds, and the step closes normally.
  session.append("tool/result", {
    turn: 1,
    step: 1,
    message: toolResult("t1", "call-1", "ok"),
  }, { surfaceOp: "append" });
  session.append("step/end", { turn: 1, step: 1 });

  // The loop continues in the same turn: the next pre-step commits the
  // finished main sampling before the next request.
  const continued = await preStep(
    { agent: { session } },
    async () => ({ kind: "enter", messages: [] }),
  );
  assert.equal(continued.kind, "enter");

  // A hand-built call between steps must not open a sampling of its own.
  await drain(harness.stream(auxiliaryRequest(session, "idle judge"), auxiliaryProvider));
  assert.equal(auxiliaryRuns, 2);

  // The next main request starts a fresh sampling transaction.
  session.append("step/start", { turn: 1, step: 2 });
  const second = loopRequest(session, [
    systemMessage(),
    input,
    assistant("a1", "run the command", "call-1"),
    toolResult("t1", "call-1", "ok"),
  ]);
  await drain(harness.stream(second, () => finish({ kind: "stop" })));
  session.append("assistant/message", {
    turn: 1,
    step: 2,
    message: assistant("a2", "done"),
    usage: { inputTokens: 9, outputTokens: 2 },
    stream: [],
  }, { surfaceOp: "append" });
  session.append("step/end", { turn: 1, step: 2 });
  session.append("turn/end", { turn: 1, reason: { kind: "stop" } });
  await harness.hooks.get("agent/turn-stopping")({ agent: { session } });

  return { harness, session };
}

for (const [label, config] of [["default", {}], ["explicitly disabled", { requestAudit: false }]]) {
  test(`request audit stays off (${label}) while main sampling still commits`, async () => {
    const { harness } = await runApprovalScenario(config);
    try {
      assert.equal(harness.domains.has(AUDIT_DOMAIN), false,
        "disabled audit must not open or read existing request evidence");
      const archives = archiveTypes(harness.domains);
      assert.equal(archives.get("sampling_started"), 2);
      assert.equal(archives.get("sampling_commit"), 2);
    } finally {
      await harness.dispose();
    }
  });
}

for (const inspect of [false, true]) {
  test(`an approval auxiliary call bypasses main sampling (inspect ${inspect})`, async () => {
    const { harness, session } = await runApprovalScenario({ inspect, requestAudit: true });
    try {
      const archives = archiveTypes(harness.domains);
      assert.equal(archives.get("sampling_started"), 2,
        "only the two main requests may begin a Spine sampling");
      assert.equal(archives.get("sampling_commit"), 2,
        "both main samplings commit through the normal step boundary");

      if (inspect) {
        await waitFor(() => auditRecords(harness.domains).length === 2, "captured request evidence");
        const records = auditRecords(harness.domains);
        assert.equal(records.length, 2, "the auxiliary calls add no request evidence");
        for (const record of records) {
          assert.equal(record.sessionId, session.id);
          assert.equal(record.system, null);
          assert.equal(record.messages[0].role, "system");
          assert.equal(record.purpose, null);
          assert.equal(record.attempt, 1);
        }
      }
    } finally {
      await harness.dispose();
    }
  });
}

test("a real main-request re-entry still faults the lifecycle", async () => {
  const harness = mount({ inspect: false });
  try {
    const session = harness.store.create("reentry");
    const preStep = harness.hooks.get("agent/pre-step");
    const input = user("u1", "task");
    session.append("turn/start", { turn: 1 });
    await preStep({ agent: { session } }, async () => ({ kind: "enter", messages: [input] }));
    session.append("step/start", { turn: 1, step: 1 });
    session.append("user/message", input, { surfaceOp: "append" });

    const request = loopRequest(session, [systemMessage(), input]);
    await drain(harness.stream(request, () => finish({ kind: "tool-calls" })));

    await assert.rejects(
      drain(harness.stream(request, () => finish({ kind: "stop" }))),
      (error) => {
        assert.match(error.message, /DSH Spine lifecycle fault/);
        const cause = error.cause;
        assert.ok(cause instanceof Error);
        assert.match(cause.message, /prior step ended/);
        return true;
      },
    );
  } finally {
    await harness.dispose();
  }
});
