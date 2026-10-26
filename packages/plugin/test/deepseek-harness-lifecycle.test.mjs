import assert from "node:assert/strict";
import test from "node:test";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";

import {
  DeepSeekHarnessSamplingLifecycle,
} from "../dist/deepseek-harness/lifecycle.js";
import { DeepSeekHarnessSourceBindings } from "../dist/deepseek-harness/messages.js";
import { apply, name, observeEvent } from "../dist/deepseek-harness/extension.js";

const EMPTY_SOURCE = {
  schema: "spine.source.snapshot.v1",
  thread: "dsh-1",
  epoch: 0,
  cells: [],
};

function message(id, source = { kind: "user" }) {
  return { id, role: "user", content: [{ type: "text", text: id }], source };
}

function adapter(log) {
  let ordinal = 0;
  return {
    fault: null,
    async observeSources(characters) {
      log.push(["observe", characters]);
      return characters.map(() => ({ thread: "dsh-1", epoch: 0, ordinal: ordinal++ }));
    },
    async beginSampling(digest) { log.push(["begin", digest]); },
    async registerExecution(key) { log.push(["register", key]); },
    async stageExecution(key, ref, operation) { log.push(["stage", key, ref, operation]); },
    async finishExecution(key, succeeded) { log.push(["finish-execution", key, succeeded]); },
    async finishSampling(terminal, inputTokens) { log.push(["finish", terminal, inputTokens]); },
    dispose() { log.push(["dispose"]); },
  };
}

test("DSH lifecycle serializes typed source, execution, and PostSampling boundaries", async () => {
  const log = [];
  const lifecycle = new DeepSeekHarnessSamplingLifecycle(
    adapter(log),
    new DeepSeekHarnessSourceBindings(),
    EMPTY_SOURCE,
  );
  lifecycle.enqueueMessage(message("user-1"), null);
  await lifecycle.beginSampling({ provider: "test", signal: new AbortController().signal });
  assert.equal(lifecycle.enqueueToolStart({
    callId: "call-1",
    name: "spine_open",
    arguments: JSON.stringify({ goal: "child" }),
  }), true);
  lifecycle.enqueueToolFinish("call-1", true);
  lifecycle.enqueueMessage(message("tool-1", { kind: "tool", callId: "call-1" }), null, 17);
  lifecycle.enqueueSuccessfulStepEnd();
  await lifecycle.finishPendingSuccess();

  assert.deepEqual(log.map(([kind]) => kind), [
    "observe",
    "begin",
    "register",
    "stage",
    "finish-execution",
    "observe",
    "finish",
  ]);
  assert.deepEqual(log[3][3], { type: "open", summary: "child" });
  assert.deepEqual(log.at(-1), ["finish", "completed", 17]);
});

test("DSH lifecycle permanently faults on ownership violation", async () => {
  const lifecycle = new DeepSeekHarnessSamplingLifecycle(
    adapter([]),
    new DeepSeekHarnessSourceBindings(),
    EMPTY_SOURCE,
  );
  lifecycle.violate(new Error("native compaction"));
  await assert.rejects(lifecycle.drain(), /lifecycle fault/);
  await assert.rejects(lifecycle.beginSampling({}), /lifecycle fault/);
});

test("DSH successful step marker defers commit and an exceptional boundary overrides it", async () => {
  const log = [];
  const lifecycle = new DeepSeekHarnessSamplingLifecycle(
    adapter(log),
    new DeepSeekHarnessSourceBindings(),
    EMPTY_SOURCE,
  );
  await lifecycle.beginSampling({ provider: "test" });
  lifecycle.enqueueSuccessfulStepEnd();
  await lifecycle.finishNow("failed");
  assert.deepEqual(log.filter(([kind]) => kind === "finish"), [["finish", "failed", undefined]]);
});

test("loadable DSH extension registers exactly the four canonical tools", () => {
  const tools = [];
  const listeners = [];
  const ctx = {
    sessions: {},
    subagents: {},
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    systemPrompt: { getSectionOrder: () => 500, section: () => () => {} },
    get() { return undefined; },
    on(event, listener) { listeners.push([event, listener]); return () => {}; },
    effect() {},
    inject() {},
  };
  apply(ctx, {});
  assert.equal(name, "spine");
  assert.deepEqual(tools.map((tool) => tool.name), [
    "spine_open",
    "spine_close",
    "spine_next",
    "spine_spawn",
  ]);
  assert.ok(listeners.some(([event]) => event === "llm/stream"));
  assert.ok(listeners.some(([event]) => event === "agent/pre-step"));
  for (const tool of tools) {
    assertSupportedJsonSchema(tool.parameters);
    assertSupportedJsonSchema(tool.output.schema);
    assert.equal(typeof tool.execute, "function");
  }
});

test("DSH extension preserves identity when disabled and rejects native compaction owner", () => {
  let touched = false;
  const disabled = {
    get sessions() { touched = true; throw new Error("touched"); },
  };
  apply(disabled, { enabled: false });
  assert.equal(touched, false);

  assert.throws(() => apply({ get: () => ({}), sessions: {}, tools: {}, subagents: {} }, {}),
    /native compaction provider/);
});

test("DSH session events map real tool and PTC payloads", () => {
  const calls = [];
  const state = {
    lifecycle: {
      enqueueMessage: (...args) => calls.push(["message", ...args]),
      enqueueToolStart: (start) => calls.push(["start", start]),
      enqueueToolFinish: (id, ok) => calls.push(["finish", id, ok]),
      enqueueSuccessfulStepEnd: () => calls.push(["step-end"]),
      enqueueFinish: (terminal) => calls.push(["turn-end", terminal]),
      violate: (error) => calls.push(["violate", error.message]),
    },
  };
  const tool = {
    id: "tool-1",
    role: "tool",
    source: { kind: "tool", callId: "call-1" },
    toolCallId: "call-1",
    isError: true,
    content: [{ type: "text", text: "failed" }],
  };
  observeEvent(state, {
    type: "tool/result",
    seq: 1,
    time: 1,
    data: { turn: 1, step: 1, message: tool },
    surfaceOp: "append",
  });
  observeEvent(state, {
    type: "tool/ptc-dispatch-start",
    seq: 2,
    time: 2,
    data: {
      rootCallId: "root",
      parentCallId: "parent",
      subCallId: "parent:ptc:1",
      name: "spine_open",
      arguments: { goal: "child" },
    },
  });
  observeEvent(state, {
    type: "tool/ptc-dispatch",
    seq: 3,
    time: 3,
    data: {
      rootCallId: "root",
      parentCallId: "parent",
      subCallId: "parent:ptc:1",
      name: "spine_open",
      arguments: { goal: "child" },
      isError: false,
      content: [],
    },
  });
  observeEvent(state, { type: "system/message", seq: 4, time: 4, data: {} });
  observeEvent(state, { type: "step/end", seq: 5, time: 5, data: {} });
  observeEvent(state, {
    type: "turn/end",
    seq: 6,
    time: 6,
    data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } },
  });
  observeEvent(state, { type: "compaction/start", seq: 7, time: 7, data: {} });

  assert.deepEqual(calls[0], ["finish", "call-1", false]);
  assert.deepEqual(calls[1], ["message", tool, calls[1][2]]);
  assert.equal(calls[1][2].type, "tool/result");
  assert.deepEqual(calls[2], ["start", {
    callId: "parent:ptc:1",
    name: "spine_open",
    arguments: { goal: "child" },
  }]);
  assert.deepEqual(calls[3], ["finish", "parent:ptc:1", true]);
  assert.deepEqual(calls[4], ["step-end"]);
  assert.deepEqual(calls[5], ["turn-end", "cancelled"]);
  assert.match(calls[6][1], /compaction\/start/);
});

test("DSH tool results map isError to Spine execution success", () => {
  const results = [];
  const state = {
    lifecycle: {
      enqueueToolFinish: (id, ok) => results.push([id, ok]),
      enqueueMessage: () => {},
    },
  };
  const message = (isError) => ({
    id: "tool-1",
    role: "tool",
    source: { kind: "tool", callId: "call-1" },
    toolCallId: "call-1",
    ...(isError === undefined ? {} : { isError }),
    content: [{ type: "text", text: "done" }],
  });
  for (const isError of [false, undefined, true]) {
    observeEvent(state, {
      type: "tool/result",
      seq: 1,
      time: 1,
      data: { turn: 1, step: 1, message: message(isError) },
      surfaceOp: "append",
    });
  }
  assert.deepEqual(results, [
    ["call-1", true],
    ["call-1", true],
    ["call-1", false],
  ]);
});

test("DSH failed Spine execution is committed as failed, not succeeded", async () => {
  const log = [];
  const lifecycle = new DeepSeekHarnessSamplingLifecycle(
    adapter(log),
    new DeepSeekHarnessSourceBindings(),
    { schema: "spine.source.snapshot.v1", thread: "dsh-1", epoch: 0, cells: [] },
  );
  await lifecycle.beginSampling({ provider: "test" });
  assert.equal(lifecycle.enqueueToolStart({
    callId: "call-1",
    name: "spine_open",
    arguments: { goal: "child" },
  }), true);
  lifecycle.enqueueToolFinish("call-1", false);
  await lifecycle.finishNow("completed");
  assert.deepEqual(log.filter(([kind]) => kind === "finish-execution"), [
    ["finish-execution", "call-1", false],
  ]);
});

test("a published plan copy cannot prove a pre-admitted input's acceptance", async () => {
  const inputMessage = message("input-1");
  const isPublishedSeq = (seq) => seq === 5;
  const lifecycle = new DeepSeekHarnessSamplingLifecycle(
    adapter([]),
    new DeepSeekHarnessSourceBindings(),
    { schema: "spine.source.snapshot.v1", thread: "dsh-1", epoch: 0, cells: [] },
    { isPublishedSeq },
  );
  const admitted = await lifecycle.admitInput([inputMessage]);
  assert.equal(admitted.length, 1);
  lifecycle.enqueueMessage(inputMessage, {
    type: "user/message",
    seq: 5,
    time: 1,
    data: inputMessage,
    surfaceOp: "append",
  });
  await assert.rejects(
    lifecycle.beginSampling({}),
    (error) => /pre-admitted input/.test(String(error?.cause?.cause ?? error?.cause ?? error)),
  );

  const accepted = new DeepSeekHarnessSamplingLifecycle(
    adapter([]),
    new DeepSeekHarnessSourceBindings(),
    { schema: "spine.source.snapshot.v1", thread: "dsh-2", epoch: 0, cells: [] },
    { isPublishedSeq: () => false },
  );
  await accepted.admitInput([inputMessage]);
  accepted.enqueueMessage(inputMessage, {
    type: "user/message",
    seq: 6,
    time: 1,
    data: inputMessage,
    surfaceOp: "append",
  });
  await accepted.beginSampling({});
});
