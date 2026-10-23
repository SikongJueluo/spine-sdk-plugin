import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import * as jsonBackend from "@deepseek-ai/dsh-storage-json";
import * as storageDomain from "@deepseek-ai/dsh-storage-domain";

import {
  DEEPSEEK_HARNESS_LEDGER_DOMAIN_SPEC,
  DomainDeepSeekHarnessLedger,
  MemoryDeepSeekHarnessLedger,
  openDeepSeekHarnessLedger,
} from "../dist/deepseek-harness/index.js";

class FileTable {
  constructor(dir) { this.dir = dir; }
  entries() {
    const values = [];
    for (const name of readdirSync(this.dir).sort()) {
      values.push([name, JSON.parse(readFileSync(join(this.dir, name), "utf8"))]);
    }
    return values[Symbol.iterator]();
  }
  async put(key, value) {
    const path = join(this.dir, key);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, path);
  }
}

class FileDomain {
  constructor(dir) { this.dir = dir; }
  table() { return new FileTable(this.dir); }
  async close() {}
}

const STARTED = {
  schema: "spine-plugin/deepseek-harness/v1",
  durabilityId: "attempt-1",
  record: {
    type: "sampling_started",
    record: {
      schema: "spine.sampling.started",
      attempt_id: { thread: "thread-1", value: "attempt-1" },
      epoch: 0,
      pre_boundary: { thread: "thread-1", epoch: 0, ordinal: 1 },
      previous_commit_id: null,
    },
  },
};

test("Spine ledger declares one per-record domain with validated entries", async () => {
  assert.equal(DEEPSEEK_HARNESS_LEDGER_DOMAIN_SPEC.name, "spine_dsh_ledger");
  assert.equal(DEEPSEEK_HARNESS_LEDGER_DOMAIN_SPEC.layout, "per-record");
  assert.deepEqual(Object.keys(DEEPSEEK_HARNESS_LEDGER_DOMAIN_SPEC.tables), ["entries"]);
  const schema = DEEPSEEK_HARNESS_LEDGER_DOMAIN_SPEC.tables.entries.valueSchema;
  assert.equal(schema.safeParse({
    schema: "spine.dsh.ledger.v1",
    sessionId: "s",
    sessionCreatedAt: 1,
    ordinal: 0,
    anchorSeq: 1,
    kind: "archive",
    archive: STARTED,
  }).success, true);
  assert.equal(schema.safeParse({ schema: "spine.dsh.ledger.v1" }).success, false);
});

test("Spine ledger round-trips journal entries through a real file medium", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-ledger-"));
  const first = new DomainDeepSeekHarnessLedger(new FileDomain(dir));
  await first.appendArchive("session-1", 100, 3, STARTED);
  await first.appendSpawnTerminal("session-1", 100, 4, "batch-1", {
    ordinal: 0,
    outcome: "completed",
    memory_body: "child memory",
  });
  await first.appendArchive("session-2", 200, 1, { ...STARTED, durabilityId: "other" });
  await first.close();

  const second = new DomainDeepSeekHarnessLedger(new FileDomain(dir));
  const session = await second.entries("session-1", 100);
  assert.deepEqual(session.map((entry) => entry.kind), ["archive", "spawn-terminal"]);
  assert.deepEqual(session.map((entry) => entry.ordinal), [0, 1]);
  assert.deepEqual(session.map((entry) => entry.anchorSeq), [3, 4]);
  assert.equal(session[1].result.memory_body, "child memory");
  assert.equal((await second.entries("session-2", 200)).length, 1);
  await second.close();
});

test("Spine ledger rejects lifecycle reuse and corrupt authoritative records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-ledger-"));
  const ledger = new DomainDeepSeekHarnessLedger(new FileDomain(dir));
  await ledger.appendArchive("session-1", 100, 0, STARTED);
  await assert.rejects(
    () => ledger.entries("session-1", 101),
    /different session lifecycle/,
  );
  await ledger.close();

  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  writeFileSync(join(dir, files[0]), JSON.stringify({ schema: "spine.dsh.ledger.v1" }));
  assert.throws(
    () => new DomainDeepSeekHarnessLedger(new FileDomain(dir)),
    /invalid/,
  );
});

test("in-memory ledger preserves per-session order", async () => {
  const ledger = new MemoryDeepSeekHarnessLedger();
  await ledger.appendArchive("s", 1, 0, STARTED);
  await ledger.appendArchive("s", 1, 2, { ...STARTED, durabilityId: "attempt-2" });
  assert.deepEqual(
    (await ledger.entries("s", 1)).map((entry) => entry.anchorSeq),
    [0, 2],
  );
  await ledger.close();
});

test("Spine ledger opens on the real DSH storage domain and survives reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "spine-domain-"));
  const ctx = new Context();
  const storage = new Storage(ctx);
  await jsonBackend.apply(ctx, { root });
  await storageDomain.apply(ctx, { backend: "json" });

  const first = await openDeepSeekHarnessLedger(ctx.storageDomain);
  await first.appendArchive("session-1", 100, 3, STARTED);
  await first.appendSpawnTerminal("session-1", 100, 4, "batch-1", {
    ordinal: 0,
    outcome: "completed",
    memory_body: "child memory",
  });
  await first.close();

  const second = await openDeepSeekHarnessLedger(ctx.storageDomain);
  const entries = await second.entries("session-1", 100);
  assert.deepEqual(entries.map((entry) => entry.kind), ["archive", "spawn-terminal"]);
  assert.equal(entries[1].result.memory_body, "child memory");
  await second.close();
});

test("fork inheritance copies only spawn terminals inside the inherited cut", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { SessionStore } = await import("@deepseek-ai/dsh-session");
  const { inheritForkLedger } = await import("../dist/deepseek-harness/extension.js");

  const ctx = new Context();
  ctx.on("session/flush", () => {});
  const store = new SessionStore(ctx);
  const parent = store.create("parent");
  parent.append("system/message", {
    turn: 1,
    step: 1,
    message: {
      id: "system-1",
      role: "system",
      content: [{ type: "text", text: "SYSTEM" }],
      source: { kind: "system-prompt" },
    },
  }, { surfaceOp: "append" });
  parent.append("user/message", {
    id: "u1",
    role: "user",
    content: [{ type: "text", text: "hello" }],
    source: { kind: "user" },
  }, { surfaceOp: "append" });
  parent.append("assistant/message", {
    turn: 1,
    step: 1,
    message: {
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      source: { kind: "model", provider: "p", model: "m" },
    },
    stream: [],
  }, { surfaceOp: "append" });

  const ledger = new MemoryDeepSeekHarnessLedger();
  await ledger.appendArchive(parent.id, parent.header.createdAt, 2, STARTED);
  await ledger.appendArchive(parent.id, parent.header.createdAt, 3, {
    ...STARTED,
    durabilityId: "attempt-2",
  });
  await ledger.appendSpawnTerminal(parent.id, parent.header.createdAt, 2, "batch-1", {
    ordinal: 0,
    outcome: "completed",
    summary: "done",
    memory: null,
  });
  const child = store.fork(parent, 1, "child");
  assert.equal(child.header.parentSession, "parent");
  assert.equal(child.inheritedEventCount, 2);

  // Sampling archives must NOT be inherited: replaying a parent's sampling
  // identities into the forked namespace makes the runtime reject the child's
  // first sampling. The child rebuilds its tree from replayed host events.
  await inheritForkLedger(child, ledger);
  const inherited = await ledger.entries(child.id, child.header.createdAt);
  assert.deepEqual(
    inherited.map((entry) => (entry.kind === "spawn-terminal" ? entry.batchId : entry.kind)),
    ["batch-1"],
  );
  await inheritForkLedger(child, ledger);
  assert.equal((await ledger.entries(child.id, child.header.createdAt)).length, 1);
});

test("concurrent child terminals keep distinct ordinals on the real domain", async () => {
  const root = mkdtempSync(join(tmpdir(), "spine-concurrent-"));
  const ctx = new Context();
  const storage = new Storage(ctx);
  await jsonBackend.apply(ctx, { root });
  await storageDomain.apply(ctx, { backend: "json" });

  const ledger = await openDeepSeekHarnessLedger(ctx.storageDomain);
  const terminal = (ordinal) => ({
    ordinal,
    outcome: "completed",
    memory_body: `memory-${ordinal}`,
  });
  await Promise.all([
    ledger.appendSpawnTerminal("session-1", 100, 1, "batch-1", terminal(0)),
    ledger.appendSpawnTerminal("session-1", 100, 1, "batch-1", terminal(1)),
  ]);
  // A duplicate delivery after a crash must not allocate a second ordinal.
  await ledger.appendSpawnTerminal("session-1", 100, 1, "batch-1", terminal(0));
  const before = await ledger.entries("session-1", 100);
  assert.deepEqual(before.map((entry) => entry.ordinal), [0, 1]);
  await ledger.close();

  const reopened = await openDeepSeekHarnessLedger(ctx.storageDomain);
  const after = await reopened.entries("session-1", 100);
  assert.deepEqual(after.map((entry) => entry.result.ordinal), [0, 1]);
  assert.deepEqual(after.map((entry) => entry.ordinal), [0, 1]);
  await reopened.close();
});

test("a failed durable write does not consume an ordinal or leave memory ahead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-failure-"));
  const table = new FileTable(dir);
  let failNext = true;
  const flakyTable = {
    entries: () => table.entries(),
    async put(key, value) {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      await table.put(key, value);
    },
  };
  const ledger = new DomainDeepSeekHarnessLedger({
    table: () => flakyTable,
    async close() {},
  });
  await assert.rejects(
    () => ledger.appendSpawnTerminal("session-1", 100, 1, "batch-1", {
      ordinal: 0,
      outcome: "completed",
      memory_body: "memory",
    }),
    /disk full/,
  );
  assert.deepEqual(await ledger.entries("session-1", 100), []);
  await ledger.appendSpawnTerminal("session-1", 100, 1, "batch-1", {
    ordinal: 0,
    outcome: "completed",
    memory_body: "memory",
  });
  assert.deepEqual(
    (await ledger.entries("session-1", 100)).map((entry) => entry.ordinal),
    [0],
  );
  await ledger.close();
});

test("concurrent duplicate archives allocate one journal entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-dedupe-"));
  const ledger = new DomainDeepSeekHarnessLedger(new FileDomain(dir));
  await Promise.all([
    ledger.appendArchive("session-1", 100, 1, STARTED),
    ledger.appendArchive("session-1", 100, 1, STARTED),
  ]);
  assert.equal((await ledger.entries("session-1", 100)).length, 1);
  await ledger.close();
});
