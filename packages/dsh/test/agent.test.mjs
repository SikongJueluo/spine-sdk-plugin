import assert from "node:assert/strict";
import test from "node:test";

import { createDeveloperMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import { loadSpineConfigToml } from "@spinejit/spine-sdk/host";

import { SpineAgent } from "../dist/agent.js";

const notice = () => createUserMessage({
  content: [{ type: "text", text: "recovery notice" }],
  source: { kind: "execution-guard" },
});
const empty = () => ({ turn: 1, step: 1, message: createDeveloperMessage({ content: [], source: { kind: "spine" } }) });

async function open(session, changed = () => {}) {
  const spine = await SpineAgent.create({ id: session.id, session }, loadSpineConfigToml(), async () => {}, changed);
  return spine;
}

function shadow(session, sources) {
  return session.append("developer/message", empty(), {
    surfaceOp: { op: "replace", startSeq: sources[0].seq, endSeq: sources.at(-1).seq },
    sourceEventSeqs: sources.map(({ seq }) => seq),
  });
}

test("a guard notice shadowed with old empty slots restores once across repeated recovery", async () => {
  let session = Session.create("repeated-guard-recovery");
  const slots = [session.append("developer/message", empty(), { surfaceOp: "append" }), session.append("developer/message", empty(), { surfaceOp: "append" })];
  const original = session.append("user/message", notice(), { surfaceOp: "append" });
  shadow(session, [...slots, original]);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const spine = await open(session);
    try {
      await spine.enterStep(1, 1);
      assert.equal(spine.fault, null);
      assert.deepEqual(session.deriveMessages().map((message) => message.content[0].text), ["recovery notice"]);
    } finally {
      spine.dispose();
    }
    const restored = session.snapshotEvents().findLast((event) => event.type === "user/message");
    shadow(session, [restored]);
    session = Session.create(session.id, session.snapshotEvents());
  }
});

test("a source arriving while the candidate is published is preserved before projection", async () => {
  const session = Session.create("source-during-publication");
  session.append("user/message", notice(), { surfaceOp: "append" });
  let spine;
  let inserted = false;
  spine = await open(session, () => {
    if (inserted) return;
    inserted = true;
    const event = session.append("user/message", notice(), { surfaceOp: "append" });
    spine.accept(event);
  });
  try {
    await spine.enterStep(1, 1);
    assert.equal(spine.fault, null);
    assert.equal(session.deriveMessages().length, 2);
    assert.equal(session.snapshotEvents().filter((event) => typeof event.surfaceOp === "object").length, 0);
  } finally {
    spine.dispose();
  }
});

test("a failed candidate leaves the published projection and surface unchanged", async () => {
  const session = Session.create("invalid-candidate");
  session.append("user/message", notice(), { surfaceOp: "append" });
  const spine = await open(session);
  try {
    await spine.enterStep(1, 1);
    const published = spine.projection;
    const missing = session.append("user/message", notice(), { surfaceOp: "append" });
    spine.accept(missing);
    const replacement = shadow(session, [missing]);
    spine.accept(replacement);
    const unsupported = session.append("user/message", createUserMessage({
      content: [{ type: "text", text: "external rewrite" }], source: { kind: "agent-message" },
    }), { surfaceOp: { op: "replace", startSeq: replacement.seq, endSeq: replacement.seq }, sourceEventSeqs: [replacement.seq] });
    spine.accept(unsupported);
    const before = session.snapshotEvents();
    await assert.rejects(spine.enterStep(1, 2), /Spine context fault/);
    assert.equal(spine.projection, published);
    assert.deepEqual(session.snapshotEvents(), before);
    await assert.rejects(spine.beginSampling(), /Spine context is faulted/);
  } finally {
    spine.dispose();
  }
});

test("a partial surface write faults the agent before it can begin sampling", async () => {
  const session = Session.create("partial-surface-write");
  const slots = Array.from({ length: 2 }, () => {
    const source = session.append("user/message", notice(), { surfaceOp: "append" });
    return shadow(session, [source]);
  });
  const spine = await open(session);
  const append = session.append.bind(session);
  session.append = (type, data, placement) => {
    if (placement?.surfaceOp?.startSeq === slots[1].seq) throw new Error("injected surface write failure");
    return append(type, data, placement);
  };
  try {
    await assert.rejects(spine.enterStep(1, 1), /Spine context fault/);
    assert.equal(session.deriveMessages().length, 1, "the first write committed");
    assert.equal(spine.projection, null, "the candidate was not published");
    await assert.rejects(spine.beginSampling(), /Spine context is faulted/);
  } finally {
    spine.dispose();
  }
});
