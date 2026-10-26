import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeepSeekHarnessReplayPlan,
  DeepSeekHarnessRecoveryError,
  DeepSeekHarnessSourceBindings,
  installDeepSeekHarnessSourceBindings,
  materializeDeepSeekHarnessContext,
  observeDeepSeekHarnessMessage,
  recoverDeepSeekHarnessSession,
} from "../dist/deepseek-harness/index.js";

const user = {
  id: "user-1",
  role: "user",
  content: [{ type: "text", text: "hello" }],
  source: { kind: "user" },
};
const tool = {
  id: "tool-1",
  role: "tool",
  toolCallId: "call-1",
  isError: false,
  content: [{ type: "text", text: "ok" }],
  source: { kind: "tool", callId: "call-1" },
};

const userEvent = {
  type: "user/message",
  seq: 0,
  time: 1,
  data: user,
  surfaceOp: "append",
};
const toolEvent = {
  type: "tool/result",
  seq: 1,
  time: 2,
  data: { turn: 1, step: 1, message: tool },
  surfaceOp: "append",
};

function archiveEntry(anchorSeq, ordinal, thread = "old") {
  return {
    kind: "archive",
    anchorSeq,
    ordinal,
    archive: {
      schema: "spine-plugin/deepseek-harness/v1",
      durabilityId: `archive-${ordinal}`,
      record: {
        type: "sampling_started",
        record: {
          schema: "spine.sampling.started",
          attempt_id: { thread, value: "attempt" },
          epoch: 0,
          pre_boundary: { thread, epoch: 0, ordinal: 1 },
          previous_commit_id: null,
          prompt_digest: "prompt",
          source_digest: "source",
          record_digest: "started",
        },
      },
    },
  };
}

test("DSH message transport preserves native tool messages and canonical projections", () => {
  assert.equal(observeDeepSeekHarnessMessage(tool, 1).character.type, "opaque");
  assert.equal(observeDeepSeekHarnessMessage(tool, 1).character.boundary, 1);
  const bindings = new DeepSeekHarnessSourceBindings();
  bindings.bind(
    { thread: "s", epoch: 0, ordinal: 0 },
    { message: user, origin: userEvent },
  );
  const messages = materializeDeepSeekHarnessContext({
    transactionId: "tx",
    projection: { nodes: [], cursor: [], visible_context: [], last_boundary: 1 },
    contextPlan: {
      schema: "spine.context.plan.v2",
      thread: "s",
      epoch: 0,
      source_snapshot_digest: "source",
      plan_digest: "plan",
      cells: [
        {
          type: "source",
          source_id: { thread: "s", epoch: 0, ordinal: 0 },
          labels: [{ UserAnchor: 3 }],
        },
        {
          type: "projection",
          projection_id: { thread: "s", epoch: 0, ordinal: 1 },
          item: {
            MemorySlot: {
              Summary: { owner_node: [1], source: { start: 0, end: 1 }, body: "memory" },
            },
          },
        },
        {
          type: "projection",
          projection_id: { thread: "s", epoch: 0, ordinal: 2 },
          item: {
            SyntheticNode: {
              node_id: [1, 1],
              summary: "child & <work>",
              status: "Live",
            },
          },
        },
      ],
    },
  }, bindings);
  assert.equal(messages[0].content[0].text, "[U3]\nhello");
  assert.deepEqual(messages[1].source, { kind: "spine-context", form: "recall" });
  assert.match(messages[1].content[0].text, /<spine_memory node_id="1">/);
  assert.match(
    messages[2].content[0].text,
    /<spine_node id="1\.1" summary="child &amp; &lt;work&gt;" status="live">/,
    "the active branch descriptor is the model-visible scope state",
  );
  assert.equal(user.content[0].text, "hello");
});

test("DSH replay merges ledger archives at their durable session cut", () => {
  const plan = buildDeepSeekHarnessReplayPlan("fork", [
    userEvent,
    { type: "step/start", seq: 2, time: 3, data: { turn: 1, step: 1 } },
    { ...toolEvent, seq: 3 },
  ], [
    archiveEntry(1, 0),
  ]);
  assert.equal(plan.runtimeThread, "old");
  assert.deepEqual(plan.inputs.map((item) => item.type), ["source", "archive", "source"]);
  assert.deepEqual(plan.sources.map((item) => item.boundary), [0, 1]);
  assert.equal(plan.sources[0].observation.message.id, "user-1");
  assert.equal(plan.sources[1].observation.message.id, "tool-1");
});

test("DSH replay skips published copies and derived Spine context messages", () => {
  const publishedCopy = { ...userEvent, seq: 4 };
  const derived = {
    type: "user/message",
    seq: 5,
    time: 6,
    data: {
      id: "spine:summary",
      role: "user",
      content: [{ type: "text", text: "summary" }],
      source: { kind: "spine-context", form: "recall" },
    },
    surfaceOp: "append",
  };
  const plan = buildDeepSeekHarnessReplayPlan("s", [
    userEvent,
    publishedCopy,
    derived,
  ]);
  assert.equal(plan.sources.length, 1);
  assert.equal(plan.sources[0].observation.message.id, "user-1");
});

test("DSH replay tolerates historical native compaction events", () => {
  // A session that ran the native pruner before Spine owned it keeps its
  // compaction/prune + replacement pairs in the log; recovery must skip the
  // shadow-price events and dedup the replacement tool result against its
  // original instead of refusing to resume.
  const replacement = {
    ...toolEvent,
    seq: 3,
    data: {
      ...toolEvent.data,
      message: { ...tool, content: [{ type: "text", text: "pruned" }] },
    },
    surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 },
  };
  const plan = buildDeepSeekHarnessReplayPlan("s", [
    userEvent,
    toolEvent,
    { type: "compaction/prune", seq: 2, time: 3, data: { shadowedSeqs: [1] } },
    replacement,
  ]);
  const ids = plan.sources.map((source) => source.observation.message.id);
  assert.deepEqual(ids, ["user-1", "tool-1"]);
});

test("DSH recovery binds exact replay cells before publication and continues fork namespace", async () => {
  const log = [];
  const plan = buildDeepSeekHarnessReplayPlan("fork", [userEvent], [archiveEntry(1, 0)]);
  const source = {
    schema: "spine.source.snapshot.v1",
    thread: "old",
    epoch: 0,
    cells: [{
      source_id: { thread: "old", epoch: 0, ordinal: 0 },
      boundary: 0,
      item: { Message: { message: { boundary: 0, role: "User", content: "{}" }, user_anchor: null } },
    }],
  };
  const adapter = {
    async replayWithSources(_inputs, install) {
      log.push("replay");
      await install(source);
      log.push("publish");
    },
    async continueNamespace(thread) {
      log.push(`continue:${thread}`);
      return {
        ...source,
        thread,
        cells: source.cells.map((cell) => ({
          ...cell,
          source_id: { ...cell.source_id, thread },
        })),
      };
    },
    async previewAndPublish() { log.push("fork-publish"); },
  };
  const recovered = await recoverDeepSeekHarnessSession({
    plan,
    runtimeFactory: () => ({}),
    adapterFactory: async () => adapter,
  });
  assert.deepEqual(log, ["replay", "publish", "continue:fork", "fork-publish"]);
  assert.equal(recovered.bindings.resolve({ thread: "fork", epoch: 0, ordinal: 0 }).message.id, "user-1");
  assert.equal(recovered.bindings.origin("user-1").seq, 0);
});

test("DSH source installation fails closed on boundary mismatch", () => {
  assert.throws(() => installDeepSeekHarnessSourceBindings(
    new DeepSeekHarnessSourceBindings(),
    {
      schema: "spine.source.snapshot.v1",
      thread: "s",
      epoch: 0,
      cells: [{
        source_id: { thread: "s", epoch: 0, ordinal: 0 },
        boundary: 9,
        item: { Message: { message: { boundary: 9, role: "User", content: "{}" }, user_anchor: null } },
      }],
    },
    [{ boundary: 0, observation: observeDeepSeekHarnessMessage(user, 0, userEvent) }],
  ), DeepSeekHarnessRecoveryError);
});

test("DSH recovery disposes the adapter when replay fails", async () => {
  const failure = new Error("replay failed");
  let disposals = 0;
  await assert.rejects(
    recoverDeepSeekHarnessSession({
      plan: buildDeepSeekHarnessReplayPlan("session", []),
      runtimeFactory: () => ({}),
      adapterFactory: async () => ({
        async replayWithSources() { throw failure; },
        dispose() { disposals += 1; },
      }),
    }),
    failure,
  );
  assert.equal(disposals, 1);
});

test("Spine anchors human user messages but not producer-owned context", () => {
  const bindings = new DeepSeekHarnessSourceBindings();
  const goal = {
    id: "goal-1",
    role: "user",
    source: { kind: "goal" },
    content: [{ type: "text", text: "continue goal" }],
  };
  bindings.bind({ thread: "s", epoch: 0, ordinal: 0 }, { message: goal, origin: null });
  const messages = materializeDeepSeekHarnessContext({
    transactionId: null,
    projection: { nodes: [], cursor: [], visible_context: [], last_boundary: null },
    contextPlan: {
      schema: "spine.context.plan.v2",
      thread: "s",
      epoch: 0,
      cells: [{
        type: "source",
        source_id: { thread: "s", epoch: 0, ordinal: 0 },
        labels: [{ UserAnchor: 1 }],
      }],
    },
  }, bindings);
  assert.equal(messages[0].content[0].text, "continue goal");
  assert.deepEqual(messages[0].source, { kind: "goal" });
});
