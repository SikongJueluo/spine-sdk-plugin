import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { validateStoredEvents } from "@deepseek-ai/dsh-session-persistence";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import {
  apply,
  isHostAcceptanceEvent,
  observeEvent,
  preparePreStepDecision,
  recoverState,
} from "../dist/deepseek-harness/extension.js";
import {
  buildDeepSeekHarnessReplayPlan,
  createDeepSeekHarnessSessionPort,
  createDeepSeekHarnessSpineAdapter,
  DeepSeekHarnessSourceBindings,
  DeepSeekHarnessSurfacePublisher,
  materializeDeepSeekHarnessContext,
  DeepSeekHarnessSamplingLifecycle,
  MemoryDeepSeekHarnessLedger,
  recoverDeepSeekHarnessSession,
} from "../dist/deepseek-harness/index.js";

function liveSession(id = "live") {
  const ctx = new Context();
  let flushes = 0;
  ctx.on("session/flush", () => { flushes += 1; });
  const store = new SessionStore(ctx);
  const session = store.create(id);
  return { ctx, store, session, flushCount: () => flushes };
}

function user(id, text, source = { kind: "user" }) {
  return { id, role: "user", content: [{ type: "text", text }], source };
}

function assistant(id, text, toolCallId) {
  return {
    id,
    role: "assistant",
    content: toolCallId === undefined
      ? [{ type: "text", text }]
      : [{ type: "text", text }, { type: "tool-call", id: toolCallId, name: "bash", arguments: "{}" }],
    source: { kind: "model", provider: "test", model: "test" },
  };
}

function toolResult(id, callId, text) {
  return {
    id,
    role: "tool",
    source: { kind: "tool", callId },
    toolCallId: callId,
    isError: false,
    content: [{ type: "text", text }],
  };
}

function system(store, session, text = "SYSTEM") {
  session.append("system/message", {
    turn: 1,
    step: 1,
    message: {
      id: "system-1",
      role: "system",
      content: [{ type: "text", text }],
      source: { kind: "system-prompt" },
    },
  }, { surfaceOp: "append" });
}

function originsOf(events) {
  const origins = new Map();
  for (const event of events) {
    if (event.type === "user/message") origins.set(event.data.id, event);
    else if (event.type === "assistant/message") origins.set(event.data.message.id, event);
    else if (event.type === "tool/result") origins.set(event.data.message.id, event);
  }
  return origins;
}

test("surface publisher compacts with native replace events and is idempotent", async () => {
  const { store, session } = liveSession("publish");
  system(store, session);
  session.append("user/message", user("u1", "hello"), { surfaceOp: "append" });

  const origins = originsOf(session.snapshotEvents());
  const publisher = new DeepSeekHarnessSurfacePublisher(
    session,
    store,
    (id) => origins.get(id) ?? null,
  );

  // The first plan anchors the user message: one in-place replacement, no copy
  // of the original conversation and no appended duplicate.
  const anchored = [user("u1", "[U1]\nhello")];
  assert.equal(await publisher.publish(anchored), 1);
  assert.deepEqual(
    session.deriveMessages().map((message) => [message.role, message.id, message.content[0].text]),
    [["system", "system-1", "SYSTEM"], ["user", "u1", "[U1]\nhello"]],
  );

  session.append("assistant/message", {
    turn: 1,
    step: 1,
    message: assistant("a1", "hi", "call-1"),
    stream: [],
  }, { surfaceOp: "append" });
  session.append("tool/result", {
    turn: 1,
    step: 1,
    message: toolResult("t1", "call-1", "ok"),
  }, { surfaceOp: "append" });
  session.append("user/message", user("u2", "next"), { surfaceOp: "append" });

  const tailSeq = session.surface.nodes.at(-1);
  const seqBeforeCompact = session.seq;
  const target = [
    user("u1", "[U1]\nhello"),
    user("summary", "<spine_memory>summary</spine_memory>", { kind: "spine-context", form: "recall" }),
    user("u2", "next"),
  ];
  assert.equal(await publisher.publish(target), 1, "one replacement must replace the compacted range");
  assert.equal(session.seq, seqBeforeCompact + 1);
  assert.equal(session.surface.nodes.at(-1), tailSeq, "the surviving tail must keep its surface node");
  assert.deepEqual(
    session.deriveMessages().map((message) => [message.role, message.id]),
    [["system", "system-1"], ["user", "u1"], ["user", "summary"], ["user", "u2"]],
  );
  const stored = validateStoredEvents(
    session.header,
    structuredClone(session.snapshotEvents()),
  );
  assert.equal(stored.length, session.seq);
  const seqAfterFirst = session.seq;
  assert.equal(await publisher.publish(target), 0);
  assert.equal(session.seq, seqAfterFirst);

  // A cold restore folds the same published surface from the log.
  const restored = liveSession("publish");
  const copy = restored.store.create("publish-copy", {
    seed: session.snapshotEvents(),
    meta: { createdAt: session.header.createdAt },
  });
  assert.deepEqual(
    copy.deriveMessages().map((message) => [message.role, message.id]),
    session.deriveMessages().map((message) => [message.role, message.id]),
  );
});

test("surface publisher re-appends real assistant and tool identities after compaction", async () => {
  const { store, session } = liveSession("copies");
  system(store, session);
  session.append("user/message", user("u1", "hello"), { surfaceOp: "append" });
  session.append("assistant/message", {
    turn: 1,
    step: 1,
    message: assistant("a1", "hi", "call-1"),
    usage: { inputTokens: 3, outputTokens: 5 },
    stream: [{ type: "text", text: "hi", time: 1 }],
  }, { surfaceOp: "append" });
  session.append("tool/result", {
    turn: 1,
    step: 1,
    message: toolResult("t1", "call-1", "ok"),
  }, { surfaceOp: "append" });

  const origins = originsOf(session.snapshotEvents());
  const publisher = new DeepSeekHarnessSurfacePublisher(
    session,
    store,
    (id) => origins.get(id) ?? null,
  );
  const target = [
    user("u1", "[U1]\nhello"),
    user("summary", "summary", { kind: "spine-context", form: "recall" }),
    assistant("a1", "hi", "call-1"),
    toolResult("t1", "call-1", "ok"),
  ];
  await publisher.publish(target);
  assert.deepEqual(
    session.deriveMessages().map((message) => [message.role, message.id]),
    [["system", "system-1"], ["user", "u1"], ["user", "summary"], ["assistant", "a1"], ["tool", "t1"]],
  );
  const copy = liveSession("copies");
  const restored = copy.store.create("copies-copy", {
    seed: session.snapshotEvents(),
    meta: { createdAt: session.header.createdAt },
  });
  assert.deepEqual(
    restored.deriveMessages().map((message) => [message.role, message.id]),
    session.deriveMessages().map((message) => [message.role, message.id]),
  );
});

test("Spine recovery publishes a real WASM ContextPlan and restores without republishing", async () => {
  const { store, session, flushCount } = liveSession("e2e");
  system(store, session);
  const first = session.append("user/message", user("u1", "explain the build"), { surfaceOp: "append" });
  const ledger = new MemoryDeepSeekHarnessLedger();

  const recovered = await recoverWith(session, store, ledger, null);
  await recovered.adapter.beginSampling();
  await recovered.adapter.finishSampling("completed");

  const published = session.deriveMessages();
  validateStoredEvents(session.header, structuredClone(session.snapshotEvents()));
  assert.equal(published[0].role, "system");
  assert.ok(published.some((message) => message.role === "user" && message.id === "u1"));
  assert.ok(flushCount() > 0);
  assert.deepEqual(
    (await ledger.entries(session.id, session.header.createdAt)).map((entry) => entry.kind),
    ["archive", "archive"],
  );

  const restoredContext = new Context();
  restoredContext.on("session/flush", () => {});
  const restoredStore = new SessionStore(restoredContext);
  const second = restoredStore.create(session.id, {
    seed: session.snapshotEvents(),
    meta: { createdAt: session.header.createdAt },
  });
  const replay = buildDeepSeekHarnessReplayPlan(
    second.id,
    second.snapshotEvents(),
    await ledger.entries(session.id, session.header.createdAt),
  );
  const seqBeforeRecovery = second.seq;
  const recoveredAgain = await recoverWith(second, restoredStore, ledger, replay);
  assert.deepEqual(
    second.deriveMessages().map((message) => [message.role, message.id]),
    published.map((message) => [message.role, message.id]),
  );
  assert.equal(second.seq, seqBeforeRecovery, "recovery must not republish an unchanged plan");
  recoveredAgain.adapter.dispose();
  recovered.adapter.dispose();
});

test("concrete port fails closed when the host has no durability listener", async () => {
  const ctx = new Context();
  const store = new SessionStore(ctx);
  const session = store.create("no-durability");
  const ledger = new MemoryDeepSeekHarnessLedger();
  const bindings = new DeepSeekHarnessSourceBindings();
  const port = createDeepSeekHarnessSessionPort({ session, sessions: store, ledger, bindings });
  await assert.rejects(
    port.publishAtomicSurface({
      schema: "spine-host-protocol/v1",
      transactionId: null,
      contextPlan: {
        schema: "spine.context.plan.v2",
        thread: "no-durability",
        epoch: 0,
        cells: [],
      },
      projection: { nodes: [], cursor: [], visible_context: [], last_boundary: null },
      messages: [user("needs-durability", "hello", { kind: "spine-context", form: "recall" })],
    }),
    /durability listener/,
  );
  await ledger.close();
});

async function recoverWith(session, store, ledger, replayPlan) {
  const bindings = new DeepSeekHarnessSourceBindings();
  let runtime;
  const recovered = await recoverDeepSeekHarnessSession({
    plan: replayPlan ?? buildDeepSeekHarnessReplayPlan(session.id, session.snapshotEvents(), await ledger.entries(session.id, session.header.createdAt)),
    runtimeFactory(thread) {
      runtime = createNodeSpineRuntime({ thread, features: ["jit", "spawn"] });
      return runtime.client;
    },
    async adapterFactory(client, sourceBindings) {
      const port = createDeepSeekHarnessSessionPort({
        session,
        sessions: store,
        ledger,
        bindings: sourceBindings,
      });
      const adapter = await createDeepSeekHarnessSpineAdapter({
        enabled: true,
        runtime: client,
        host: port,
      });
      return adapter;
    },
  });
  return { ...recovered, runtime };
}

test("surface publisher rejects an unpaired tool result", async () => {
  const { store, session } = liveSession("unpaired");
  system(store, session);
  const publisher = new DeepSeekHarnessSurfacePublisher(session, store, () => null);
  await assert.rejects(
    publisher.publish([toolResult("t1", "missing-call", "orphan")]),
    /without its assistant tool call/,
  );
});

test("extension state recovery and live admission drive consecutive plans", async () => {
  const { ctx, store, session } = liveSession("extension");
  system(store, session);
  session.append("user/message", user("u1", "first"), { surfaceOp: "append" });
  const ledger = new MemoryDeepSeekHarnessLedger();
  const state = await recoverState(ctx, session, undefined, async () => ledger);
  await state.lifecycle.beginSampling();
  await state.lifecycle.finishNow("completed");
  assert.ok(session.deriveMessages().some((message) => message.id === "u1"));

  const next = session.append("user/message", user("u2", "second"), { surfaceOp: "append" });
  observeEvent(state, next);
  await state.lifecycle.beginSampling();
  await state.lifecycle.finishNow("completed");
  assert.deepEqual(
    session.deriveMessages().map((message) => message.id),
    ["system-1", "u1", "u2"],
  );
  assert.equal(
    session.deriveMessages().filter((message) => message.id === "u1").length,
    1,
  );
  state.lifecycle.dispose();
  state.runtime.dispose();
});

test("forked DSH sessions continue a parent namespace from inherited journals", async () => {
  const { ctx, store, session: parent } = liveSession("fork-parent");
  system(store, parent);
  parent.append("user/message", user("u1", "hello"), { surfaceOp: "append" });
  const ledger = new MemoryDeepSeekHarnessLedger();
  const parentState = await recoverState(ctx, parent, undefined, async () => ledger);
  await parentState.lifecycle.beginSampling();
  await parentState.lifecycle.finishNow("completed");
  const parentPlan = parent.deriveMessages().map((message) => [message.role, message.id]);

  const child = store.fork(parent, 1, "fork-child");
  assert.equal(child.header.parentSession, "fork-parent");
  const childState = await recoverState(ctx, child, undefined, async () => ledger);
  assert.deepEqual(
    child.deriveMessages().map((message) => [message.role, message.id]),
    parentPlan,
  );
  await childState.lifecycle.beginSampling();
  await childState.lifecycle.finishNow("completed");
  assert.ok((await ledger.entries(child.id, child.header.createdAt)).length >= 2);
  childState.lifecycle.dispose();
  childState.runtime.dispose();
  parentState.lifecycle.dispose();
  parentState.runtime.dispose();
});

test("concrete port validates archive and spawn records before the ledger", async () => {
  const { ctx, store, session } = liveSession("validate");
  const ledger = new MemoryDeepSeekHarnessLedger();
  const bindings = new DeepSeekHarnessSourceBindings();
  const port = createDeepSeekHarnessSessionPort({ session, sessions: store, ledger, bindings });
  await assert.rejects(
    port.persistArchive({
      schema: "spine-host-protocol/v1",
      durabilityId: "broken",
      record: { type: "sampling_started", record: { record_digest: "broken" } },
    }),
    /archive identity|sampling-started/,
  );
  await assert.rejects(
    port.persistSpawnTerminal("batch", {
      ordinal: -1,
      outcome: "completed",
      memory_body: "memory",
    }),
    /terminal result/,
  );
  assert.deepEqual(await ledger.entries(session.id, session.header.createdAt), []);
  await ledger.close();
});

test("a null context plan never hides live DSH history", async () => {
  const { ctx, store, session } = liveSession("null-plan");
  system(store, session);
  session.append("user/message", user("u1", "keep me"), { surfaceOp: "append" });
  const ledger = new MemoryDeepSeekHarnessLedger();
  const bindings = new DeepSeekHarnessSourceBindings();
  const port = createDeepSeekHarnessSessionPort({ session, sessions: store, ledger, bindings });
  const before = session.seq;
  await port.publishAtomicSurface({
    schema: "spine-host-protocol/v1",
    transactionId: null,
    contextPlan: null,
    projection: { nodes: [], cursor: [], visible_context: [], last_boundary: null },
    messages: [],
  });
  assert.equal(session.seq, before);
  assert.deepEqual(session.deriveMessages().map((message) => message.id), ["system-1", "u1"]);
  await ledger.close();
});

test("an empty plan over live history fails closed instead of erasing it", async () => {
  const { store, session } = liveSession("empty-plan");
  system(store, session);
  session.append("user/message", user("u1", "keep me"), { surfaceOp: "append" });
  const publisher = new DeepSeekHarnessSurfacePublisher(session, store, () => null);
  await assert.rejects(
    publisher.publish([]),
    /refusing to erase/,
  );
  assert.deepEqual(session.deriveMessages().map((message) => message.id), ["system-1", "u1"]);
});

test("consecutive differing plans never drop a planned message behind a carrier", async () => {
  const { store, session } = liveSession("carrier-suffix");
  system(store, session);
  for (const id of ["A", "Z", "B"]) {
    session.append("user/message", user(id, id), { surfaceOp: "append" });
  }
  const origins = originsOf(session.snapshotEvents());
  const publisher = new DeepSeekHarnessSurfacePublisher(
    session,
    store,
    (id) => origins.get(id) ?? null,
  );
  assert.ok(await publisher.publish([user("A", "A"), user("B", "B")]) > 0);
  assert.deepEqual(
    session.deriveMessages().map((message) => message.id),
    ["system-1", "A", "B"],
  );
  assert.ok(await publisher.publish([
    user("X", "X", { kind: "spine-context", form: "recall" }),
    user("B", "B"),
  ]) > 0);
  assert.deepEqual(
    session.deriveMessages().map((message) => message.id),
    ["system-1", "X", "B"],
    "a planned message before a surviving tail must not be silently omitted",
  );
});

test("pre-step publishes the plan and rewrites the first request input before assembly", async () => {
  const { ctx, store, session } = liveSession("pre-step");
  const ledger = new MemoryDeepSeekHarnessLedger();
  const state = await recoverState(ctx, session, undefined, async () => ledger);
  const claimed = user("u1", "first input");
  const firstDecision = await preparePreStepDecision(state, async () => ({ kind: "enter", messages: [claimed] }),
  );
  assert.equal(firstDecision.kind, "enter");
  const rewritten = firstDecision.messages[0];
  assert.ok(rewritten, "the current input must be rewritten to the materialized message");
  assert.notEqual(rewritten.content[0].text, claimed.content[0].text);

  const preview = await state.lifecycle.preview();
  const expected = materializeDeepSeekHarnessContext(preview, state.bindings);
  // The loop appends the system prompt and then the decision messages.
  system(store, session);
  const event = session.append("user/message", rewritten, { surfaceOp: "append" });
  observeEvent(state, event);
  const requestMessages = session.deriveMessages();
  assert.deepEqual(
    requestMessages.filter((message) => message.role !== "system")
      .map((message) => message.content[0].text),
    expected.map((message) => message.content[0].text),
    "the request text must equal the Spine materialized current input",
  );
  assert.equal(requestMessages.at(-1).content[0].text, rewritten.content[0].text);

  const seqBeforeFinish = session.seq;
  await state.lifecycle.beginSampling();
  await state.lifecycle.finishNow("completed");
  assert.equal(session.seq, seqBeforeFinish, "an unchanged first plan must not append");
  validateStoredEvents(session.header, structuredClone(session.snapshotEvents()));
  assert.deepEqual(
    session.deriveMessages().filter((message) => message.role !== "system")
      .map((message) => message.content[0].text),
    expected.map((message) => message.content[0].text),
  );

  // The next turn must publish the prior plan and rewrite the new input before
  // its own request assembly.
  const claimedNext = user("u2", "second input");
  const nextDecision = await preparePreStepDecision(state, async () => ({ kind: "enter", messages: [claimedNext] }),
  );
  assert.equal(nextDecision.kind, "enter");
  const nextInput = nextDecision.messages[0];
  assert.ok(nextInput);
  const nextPreview = await state.lifecycle.preview();
  const nextExpected = materializeDeepSeekHarnessContext(nextPreview, state.bindings);
  const nextEvent = session.append("user/message", nextInput, { surfaceOp: "append" });
  observeEvent(state, nextEvent);
  assert.deepEqual(
    session.deriveMessages().filter((message) => message.role !== "system")
      .map((message) => message.content[0].text),
    nextExpected.map((message) => message.content[0].text),
  );
  assert.equal(
    session.deriveMessages().filter((message) => message.content[0].text.includes("first input")).length,
    1,
    "the prior input must not be duplicated by the next plan",
  );
  await state.lifecycle.beginSampling();
  await state.lifecycle.finishNow("completed");

  // Cold replay must observe the original input, not the presentation anchor,
  // and must not republish or double-anchor.
  const restoredContext = new Context();
  restoredContext.on("session/flush", () => {});
  const restoredStore = new SessionStore(restoredContext);
  const restored = restoredStore.create(session.id, {
    seed: session.snapshotEvents(),
    meta: { createdAt: session.header.createdAt },
  });
  const restoredSeqBefore = restored.seq;
  const restoredState = await recoverState(
    restoredContext,
    restored,
    undefined,
    async () => ledger,
  );
  assert.deepEqual(
    restored.deriveMessages().filter((message) => message.role !== "system")
      .map((message) => message.content[0].text),
    nextExpected.map((message) => message.content[0].text),
  );
  assert.equal(restored.seq, restoredSeqBefore, "restored request must not republish");
  validateStoredEvents(restored.header, structuredClone(restored.snapshotEvents()));
  restoredState.lifecycle.dispose();
  restoredState.runtime.dispose();
  state.lifecycle.dispose();
  state.runtime.dispose();
});

test("a failed Spine execution is not committed by the real WASM runtime", async () => {
  const node = createNodeSpineRuntime({ thread: "failed-exec", features: ["jit", "spawn"] });
  try {
    await node.client.execute({
      type: "observe_sources",
      characters: [{
        type: "message",
        boundary: 0,
        role: "user",
        content: JSON.stringify(user("u1", "hello")),
      }],
    });
    await node.client.execute({ type: "begin_sampling" });
    await node.client.execute({ type: "register_execution", key: "call" });
    await node.client.execute({
      type: "stage_execution",
      key: "call",
      execution_ref: "call",
      operation: { type: "open", summary: "child" },
    });
    await node.client.execute({ type: "finish_execution", key: "call", succeeded: false });
    const prepared = await node.client.execute({ type: "prepare_finish", terminal: "completed" });
    assert.equal(prepared.type, "finish_prepared");
    assert.deepEqual(prepared.record.record.executions, []);
  } finally {
    node.dispose();
  }
});

test("real tool success and failure commit the matching Spine execution", async () => {
  for (const isError of [false, true]) {
    const { ctx, store, session } = liveSession(`exec-${isError}`);
    system(store, session);
    session.append("user/message", user("u1", "open a child"), { surfaceOp: "append" });
    session.append("assistant/message", {
      turn: 1,
      step: 1,
      message: {
        ...assistant("a1", "ok", "call-1"),
        content: [
          { type: "text", text: "ok" },
          { type: "tool-call", id: "call-1", name: "spine_open", arguments: '{"goal":"child"}' },
        ],
      },
      stream: [],
    }, { surfaceOp: "append" });
    const ledger = new MemoryDeepSeekHarnessLedger();
    const state = await recoverState(ctx, session, undefined, async () => ledger);
    await state.lifecycle.beginSampling();
    observeEvent(state, {
      type: "tool/call",
      seq: 100,
      time: 1,
      data: { turn: 1, step: 1, callId: "call-1", name: "spine_open", arguments: '{"goal":"child"}' },
    });
    observeEvent(state, {
      type: "tool/result",
      seq: 101,
      time: 2,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "t1",
          role: "tool",
          source: { kind: "tool", callId: "call-1" },
          toolCallId: "call-1",
          isError,
          content: [{ type: "text", text: isError ? "failed" : "accepted" }],
        },
      },
    });
    await state.lifecycle.finishNow("completed");
    const commit = (await ledger.entries(session.id, session.header.createdAt))
      .filter((entry) => entry.kind === "archive")
      .at(-1).archive.record.record;
    assert.equal(commit.schema, "spine.sampling.commit");
    assert.equal(commit.executions.length, isError ? 0 : 1);
    if (!isError) {
      assert.equal(commit.executions[0].operation.type, "open");
      assert.equal(commit.executions[0].origin.execution_ref, "call-1");
    }
    state.lifecycle.dispose();
    state.runtime.dispose();
  }
});

test("a pre-admitted input that never reaches the log faults the session", async () => {
  const { ctx, store, session } = liveSession("phantom-input");
  const ledger = new MemoryDeepSeekHarnessLedger();
  const state = await recoverState(ctx, session, undefined, async () => ledger);
  const claimed = user("u1", "never appended");
  await preparePreStepDecision(state, async () => ({ kind: "enter", messages: [claimed] }),
  );
  state.lifecycle.enqueueFinish("cancelled");
  await assert.rejects(
    state.lifecycle.drain(),
    (error) => /pre-admitted input/.test(String(error?.cause?.cause ?? error?.cause ?? error)),
  );
  state.lifecycle.dispose();
  state.runtime.dispose();
});

test("non-human user-role producers stay contextual inputs with their own source", async () => {
  for (const kind of ["goal", "agent-message"]) {
    const { ctx, store, session } = liveSession(`producer-${kind}`);
    const ledger = new MemoryDeepSeekHarnessLedger();
    const state = await recoverState(ctx, session, undefined, async () => ledger);
    const claimed = {
      id: `input-${kind}`,
      role: "user",
      source: { kind },
      content: [{ type: "text", text: `${kind} input` }],
    };
    const decision = await preparePreStepDecision(state, async () => ({ kind: "enter", messages: [claimed] }),
    );
    assert.equal(decision.kind, "enter");
    const accepted = decision.messages[0];
    assert.equal(accepted.source.kind, kind);
    assert.equal(accepted.content[0].text, claimed.content[0].text);
    system(store, session);
    const event = session.append("user/message", accepted, { surfaceOp: "append" });
    observeEvent(state, event);
    await state.lifecycle.beginSampling();
    await state.lifecycle.finishNow("completed");
    const visible = session.deriveMessages().find((message) => message.id === claimed.id);
    assert.equal(visible.source.kind, kind);
    assert.equal(visible.content[0].text, `${kind} input`);

    const restoredContext = new Context();
    restoredContext.on("session/flush", () => {});
    const restoredStore = new SessionStore(restoredContext);
    const restored = restoredStore.create(session.id, {
      seed: session.snapshotEvents(),
      meta: { createdAt: session.header.createdAt },
    });
    const restoredState = await recoverState(
      restoredContext,
      restored,
      undefined,
      async () => ledger,
    );
    const restoredInput = restored.deriveMessages().find((message) => message.id === claimed.id);
    assert.equal(restoredInput.source.kind, kind);
    assert.equal(restoredInput.content[0].text, `${kind} input`);
    restoredState.lifecycle.dispose();
    restoredState.runtime.dispose();
    state.lifecycle.dispose();
    state.runtime.dispose();
  }
});

test("the accepted decision, not the claimed payload, is admitted and projected", async () => {
  const { ctx, store, session } = liveSession("accepted-decision");
  const ledger = new MemoryDeepSeekHarnessLedger();
  const state = await recoverState(ctx, session, undefined, async () => ledger);
  const claimed = user("u1", "old claimed");
  const accepted = user("u1", "accepted changed");
  const decision = await preparePreStepDecision(state, async () => ({ kind: "enter", messages: [accepted] }),
  );
  const projected = decision.messages[0];
  assert.match(projected.content[0].text, /accepted changed/);
  assert.doesNotMatch(projected.content[0].text, /old claimed/);
  system(store, session);
  const event = session.append("user/message", projected, { surfaceOp: "append" });
  observeEvent(state, event);
  await state.lifecycle.beginSampling();
  await state.lifecycle.finishNow("completed");
  assert.match(session.deriveMessages().find((message) => message.id === "u1").content[0].text, /accepted changed/);
  state.lifecycle.dispose();
  state.runtime.dispose();
});

test("a replacement id accepted by next supersedes the claimed id", async () => {
  const { ctx, store, session } = liveSession("replacement-id");
  const ledger = new MemoryDeepSeekHarnessLedger();
  const state = await recoverState(ctx, session, undefined, async () => ledger);
  const claimed = user("u1", "claimed");
  const accepted = user("u2", "accepted replacement");
  const decision = await preparePreStepDecision(state, async () => ({ kind: "enter", messages: [accepted] }),
  );
  assert.equal(decision.messages[0].id, "u2");
  system(store, session);
  const event = session.append("user/message", decision.messages[0], { surfaceOp: "append" });
  observeEvent(state, event);
  await state.lifecycle.beginSampling();
  await state.lifecycle.finishNow("completed");
  assert.equal(session.deriveMessages().some((message) => message.id === "u1"), false);
  assert.equal(session.deriveMessages().some((message) => message.id === "u2"), true);
  state.lifecycle.dispose();
  state.runtime.dispose();
});

test("a failed pre-admission is discarded before the next request", async () => {
  const { ctx, store, session } = liveSession("failed-candidate");
  const ledger = new MemoryDeepSeekHarnessLedger();
  const failing = await recoverState(ctx, session, undefined, async () => ledger);
  const goal = {
    id: "goal-1",
    role: "user",
    source: { kind: "goal" },
    content: [{ type: "text", text: "never accepted goal" }],
  };
  failing.lifecycle.preview = async () => { throw new Error("preview failed"); };
  let invalidated = false;
  await assert.rejects(
    preparePreStepDecision(failing, async () => ({ kind: "enter", messages: [goal] }),
      async () => {
        invalidated = true;
        failing.lifecycle.dispose();
        failing.runtime.dispose();
      },
    ),
    /preview failed/,
  );
  assert.equal(invalidated, true);

  // Rebuild from the host log, which never accepted the failed candidate.
  const rebuilt = await recoverState(ctx, session, undefined, async () => ledger);
  const human = user("u1", "next human");
  const decision = await preparePreStepDecision(rebuilt, async () => ({ kind: "enter", messages: [human] }),
  );
  system(store, session);
  const event = session.append("user/message", decision.messages[0], { surfaceOp: "append" });
  observeEvent(rebuilt, event);
  await rebuilt.lifecycle.beginSampling();
  await rebuilt.lifecycle.finishNow("completed");
  assert.equal(
    session.deriveMessages().some((message) => message.content[0].text.includes("never accepted goal")),
    false,
  );
  rebuilt.lifecycle.dispose();
  rebuilt.runtime.dispose();
});

test("plan copies are not host acceptance evidence and cannot publish unaccepted inputs", async () => {
  const port = { isPublishedSeq: (seq) => seq === 42 };
  const hostEvent = {
    type: "user/message",
    seq: 43,
    time: 1,
    data: user("u1", "hello"),
    surfaceOp: "append",
  };
  assert.equal(isHostAcceptanceEvent(port, hostEvent), true);
  assert.equal(isHostAcceptanceEvent(port, { ...hostEvent, seq: 42 }), false);
  assert.equal(isHostAcceptanceEvent(port, {
    ...hostEvent,
    seq: 44,
    data: user("spine", "summary", { kind: "spine-context", form: "recall" }),
  }), false);

  const { store, session } = liveSession("unaccepted");
  system(store, session);
  const publisher = new DeepSeekHarnessSurfacePublisher(session, store, () => null);
  await assert.rejects(
    publisher.publish([user("phantom", "never accepted")]),
    /no accepted host event/,
  );
});

test("the loaded extension invalidates a failed pre-admission before the next step", async () => {
  const ctx = new Context();
  ctx.on("session/flush", () => {});
  const store = new SessionStore(ctx);
  const rows = new Map();
  const facility = {
    async open() {
      return {
        table: () => ({
          entries: () => rows.entries(),
          put: async (key, value) => { rows.set(key, value); },
        }),
        async close() {},
      };
    },
  };
  const listeners = new Map();
  const tools = [];
  apply({
    sessions: store,
    storageDomain: facility,
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    subagents: {},
    get() { return undefined; },
    on(name, listener) { listeners.set(name, listener); return () => {}; },
    effect() {},
  }, {});
  assert.equal(tools.length, 4);
  const preStep = listeners.get("agent/pre-step");
  const session = store.create("wiring");

  const goal = {
    id: "goal-1",
    role: "user",
    source: { kind: "goal" },
    content: [{ type: "text", text: "never accepted" }],
  };
  const originalPreview = DeepSeekHarnessSamplingLifecycle.prototype.preview;
  DeepSeekHarnessSamplingLifecycle.prototype.preview = async () => {
    throw new Error("injected preview failure");
  };
  try {
    await assert.rejects(
      preStep(
        { agent: { session }, messages: [goal] },
        async () => ({ kind: "enter", messages: [goal] }),
      ),
      /injected preview failure/,
    );
  } finally {
    DeepSeekHarnessSamplingLifecycle.prototype.preview = originalPreview;
  }

  const human = user("u1", "accepted human");
  const decision = await preStep(
    { agent: { session }, messages: [human] },
    async () => ({ kind: "enter", messages: [human] }),
  );
  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages[0].id, "u1");
  assert.match(decision.messages[0].content[0].text, /accepted human/);
  assert.doesNotMatch(decision.messages[0].content[0].text, /never accepted/);
});
