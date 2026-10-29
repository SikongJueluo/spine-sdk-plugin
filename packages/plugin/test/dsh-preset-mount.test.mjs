/**
 * Real-composition regression: a Cordis Loader mounts this package's compiled
 * Spine extension through the same `mountPreset` / `AgentPresetRegistry` path
 * DSH uses, so a root-realm service leak fails exactly as it does in a running
 * profile. The DSH test dependencies are pinned to the versions the installed
 * `0.2.0-rc.2` harness ships; `cordis-plugin-include` is pinned only so npm
 * resolves that same optional-peer set.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import {
  AgentPresetRegistry,
  leakedServices,
} from "@deepseek-ai/dsh-agent-preset-registry";
import { createScope } from "@deepseek-ai/dsh-scope";
import { SystemPrompt, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";

import { createSpineInspectionHost } from "../../spine-tree/host/broker.js";
import * as spineTreeHost from "../../spine-tree/index.js";

const require = createRequire(import.meta.url);
const registryEntry = require.resolve("@deepseek-ai/dsh-agent-preset-registry");
const { mountPreset } = await import(pathToFileURL(
  path.join(path.dirname(registryEntry), "types", "mount.js"),
).href);

const EXTENSION = fileURLToPath(new URL("../dist/deepseek-harness/extension.js", import.meta.url));

const tick = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * A real Cordis Loader plus a real `mountPreset`, the exact boundary DSH
 * enforces for Agent presets. Only Host services are stubbed: the compiled
 * Spine extension, the preset tree, the realm-leak audit and the Host broker
 * are the production implementations.
 */
async function harness(headers, options = {}) {
  const ctx = new Context();
  const loader = ctx.plugin(Loader);
  await loader;
  await tick();
  await ctx.plugin(SystemPrompt, { includeRuntimeContext: false });
  await ctx.plugin(ToolRuntime, { mode: "native" });

  const opens = [];
  const closes = [];
  const storageDomain = {
    open: async (spec) => {
      opens.push(spec.name);
      return {
        table: () => ({
          entries: () => new Map()[Symbol.iterator](),
          put: async () => {},
          delete: async () => false,
        }),
        close: async () => { closes.push(spec.name); },
      };
    },
  };
  for (const [key, value] of Object.entries({
    agents: {},
    llm: {},
    sessions: {},
    subagents: {},
    storageDomain,
  })) {
    ctx.provide(key, value);
  }
  ctx.provide("sessionController", {
    inspect: async (sessionId) => {
      const meta = headers.get(sessionId);
      if (meta === undefined) throw new Error(`unknown session ${sessionId}`);
      return { meta, events: [] };
    },
  });
  const broker = options.withBroker === false
    ? undefined
    : createSpineInspectionHost({
      presetOf: async (sessionId) => headers.get(sessionId)?.agentPreset,
    });
  if (broker !== undefined) ctx.provide("spineInspectionHost", broker);

  return { ctx, loader, broker, opens, closes };
}

function row(presetId, config = {}) {
  return {
    id: "spine",
    name: EXTENSION,
    config: { enabled: true, presetId, ...config },
  };
}

test("a Spine preset mounts without a realm leak and serves its Session through the Host broker", async () => {
  const headers = new Map([
    ["session-personal", { createdAt: 5, agentPreset: "personal" }],
    ["session-work", { createdAt: 6, agentPreset: "work" }],
  ]);
  const { ctx, loader, broker, opens, closes } = await harness(headers);
  const personalScope = createScope(loader.ctx, {});
  const workScope = createScope(loader.ctx, {});

  const personal = await mountPreset(personalScope.ctx, "personal", [row("personal", { requestAudit: true })]);
  const work = await mountPreset(workScope.ctx, "work", [row("work", { requestAudit: true })]);

  for (const mount of [personal, work]) {
    const entries = [...mount.tree.entries()];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fiber.state, 2, "the preset row is active");
    assert.deepEqual(
      leakedServices(ctx, mount.fiber),
      [],
      "no preset service reaches the root realm",
    );
  }
  assert.equal(ctx.get("spineInspection"), undefined, "the old root-realm service is gone");

  await tick(50);
  assert.deepEqual(
    broker.describe().map((entry) => entry.presetId).sort(),
    ["personal", "work"],
    "each preset revision contributes its own inspection",
  );

  const personalSelection = await broker.select("session-personal");
  assert.equal(personalSelection.kind, "ok");
  assert.equal(personalSelection.contribution.presetId(), "personal");
  const personalView = await personalSelection.contribution.view("session-personal");
  assert.equal(personalView.host.available, true);
  assert.equal(personalView.spine.state, "unavailable", "a log without Spine archives is explicit");

  const workSelection = await broker.select("session-work");
  assert.equal(workSelection.kind, "ok");
  assert.equal(workSelection.contribution.presetId(), "work");
  await workSelection.contribution.view("session-work");

  for (const domain of ["spine_dsh_audit", "spine_dsh_ledger"]) {
    assert.equal(
      opens.filter((name) => name === domain).length,
      1,
      `${domain} is opened once for both covered presets`,
    );
  }

  await personalScope.dispose();
  await tick(20);
  assert.deepEqual(
    broker.describe().map((entry) => entry.presetId),
    ["work"],
    "unloading one revision removes exactly its contribution",
  );
  assert.equal((await broker.select("session-work")).kind, "ok");
  assert.equal(
    (await broker.select("session-personal")).kind,
    "none",
    "the remaining revision must not answer for another preset's Session",
  );
  assert.deepEqual(closes, [], "the shared domains stay open while one preset remains");

  const workView = await (await broker.select("session-work")).contribution.view("session-work");
  assert.equal(workView.host.available, true);

  await workScope.dispose();
  await tick(20);
  assert.deepEqual(broker.describe(), []);
  for (const domain of ["spine_dsh_audit", "spine_dsh_ledger"]) {
    assert.equal(
      closes.filter((name) => name === domain).length,
      1,
      `${domain} closes once after the last preset revision unloads`,
    );
  }

  await ctx.fiber.dispose();
});

test("the Host companion and a preset compose into working read-only routes", async () => {
  const headers = new Map([
    ["session-personal", { createdAt: 5, agentPreset: "personal" }],
  ]);
  const { ctx, loader, opens } = await harness(headers, { withBroker: false });
  const routes = [];
  ctx.provide("connection", {
    fetch: {
      register(route) {
        routes.push(route);
        return () => Promise.resolve();
      },
    },
  });

  const hostFiber = ctx.plugin(spineTreeHost);
  await hostFiber;
  await tick(20);
  assert.ok(ctx.get("spineInspectionHost"), "the Web companion provides the broker");
  assert.deepEqual(routes.map((route) => route.path).sort(), [
    "/api/spine.request",
    "/api/spine.tree",
  ]);

  const scope = createScope(loader.ctx, {});
  await mountPreset(scope.ctx, "personal", [row("personal")]);
  await tick(20);

  const treeRoute = routes.find((route) => route.path === "/api/spine.tree");
  const tree = await (await treeRoute.fetch(
    new Request("http://host/api/spine.tree?sessionId=session-personal"),
  )).json();
  assert.equal(tree.host.available, true);
  assert.equal(tree.spine.state, "unavailable");
  assert.match(tree.spine.note, /no Spine sampling archive/);

  const detailRoute = routes.find((route) => route.path === "/api/spine.request");
  const detail = await (await detailRoute.fetch(
    new Request("http://host/api/spine.request?sessionId=session-personal&id=missing"),
  )).json();
  assert.equal(detail.ok, false);
  assert.match(detail.reason, /disabled/);
  assert.equal(tree.evidence.store, "unavailable");
  assert.deepEqual(tree.requests, []);
  assert.equal(opens.includes("spine_dsh_audit"), false,
    "default tree and request routes must never load existing request evidence");
  assert.equal(opens.includes("spine_dsh_ledger"), true);

  await scope.dispose();
  await hostFiber.dispose();
  await ctx.fiber.dispose();
});

test("a Spine preset mounts when the Web companion is absent", async () => {
  const headers = new Map([
    ["session-personal", { createdAt: 5, agentPreset: "personal" }],
  ]);
  const { ctx, loader } = await harness(headers, { withBroker: false });
  const scope = createScope(loader.ctx, {});
  const mount = await mountPreset(scope.ctx, "personal", [row("personal")]);
  const entries = [...mount.tree.entries()];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fiber.state, 2, "the optional Host broker is not a required service");
  assert.deepEqual(leakedServices(ctx, mount.fiber), []);
  assert.equal(ctx.get("spineInspectionHost"), undefined);
  await scope.dispose();
  await ctx.fiber.dispose();
});

test("a broker that appears after the preset mount receives the contribution", async () => {
  const headers = new Map([
    ["session-personal", { createdAt: 5, agentPreset: "personal" }],
  ]);
  const { ctx, loader } = await harness(headers, { withBroker: false });
  const scope = createScope(loader.ctx, {});
  await mountPreset(scope.ctx, "personal", [row("personal")]);

  const broker = createSpineInspectionHost({
    presetOf: async (sessionId) => headers.get(sessionId)?.agentPreset,
  });
  ctx.provide("spineInspectionHost", broker);
  await tick(20);
  assert.deepEqual(broker.describe().map((entry) => entry.presetId), ["personal"]);
  assert.equal((await broker.select("session-personal")).kind, "ok");

  await scope.dispose();
  await tick(10);
  assert.deepEqual(broker.describe(), [], "preset unload still removes the contribution");
  await ctx.fiber.dispose();
});

test("a pending contribution does not survive preset unload", async () => {
  const headers = new Map([
    ["session-personal", { createdAt: 5, agentPreset: "personal" }],
  ]);
  const { ctx, loader } = await harness(headers, { withBroker: false });
  const scope = createScope(loader.ctx, {});
  await mountPreset(scope.ctx, "personal", [row("personal")]);
  await scope.dispose();

  const broker = createSpineInspectionHost({
    presetOf: async (sessionId) => headers.get(sessionId)?.agentPreset,
  });
  ctx.provide("spineInspectionHost", broker);
  await tick(20);
  assert.deepEqual(broker.describe(), [], "no closure from the unloaded preset remains");
  await ctx.fiber.dispose();
});

test("a Spine preset assembles core workflow rules and the full catalog only in its scope", async () => {
  const headers = new Map([
    ["session-personal", { createdAt: 5, agentPreset: "personal" }],
  ]);
  const { ctx, loader } = await harness(headers);
  const personalKey = {};
  const otherKey = {};
  const personalScope = createScope(loader.ctx, personalKey);
  const otherScope = createScope(loader.ctx, otherKey);
  await mountPreset(personalScope.ctx, "personal", [row("personal")]);
  await tick(20);

  const assembly = await ctx.systemPrompt.assemble({ scope: personalKey });
  const rules = renderPrompt(assembly);
  assert.match(rules, /<spine_instruction>/);
  assert.match(rules, /spine_open/);
  assert.match(rules, /Only one|at most one/);
  assert.doesNotMatch(rules, /spine\.open/, "core's dotted default wording is adapted to DSH names");

  const other = renderPrompt(await ctx.systemPrompt.assemble({ scope: otherKey }));
  assert.doesNotMatch(other, /<spine_instruction>/, "another preset never inherits Spine's policy");

  const agentKey = {};
  const agentScope = createScope(loader.ctx, agentKey, { parent: personalKey });
  assert.match(
    renderPrompt(await ctx.systemPrompt.assemble({ scope: agentKey })),
    /<spine_instruction>/,
    "an agent scope inherits its preset's policy through the scope chain",
  );
  assert.ok(ctx.tools.get("spine_open", agentKey));

  const open = ctx.tools.get("spine_open", personalKey);
  assert.ok(open, "the catalog registers the DSH tool name");
  assert.ok(open.description.length > 0);
  assert.match(open.parameters.properties.goal.description, /Maximum 4096 characters/);
  const spawn = ctx.tools.get("spine_spawn", personalKey);
  assert.match(spawn.parameters.properties.tasks.description, /At least 2 items/);
  assert.equal(ctx.tools.get("spine_open", otherKey), undefined);

  await agentScope.dispose();
  await personalScope.dispose();
  await tick(20);
  assert.doesNotMatch(
    renderPrompt(await ctx.systemPrompt.assemble({ scope: personalKey })),
    /<spine_instruction>/,
    "unloading the preset removes its policy",
  );

  await otherScope.dispose();
  await ctx.fiber.dispose();
});

test("AgentPresetRegistry registers the Spine preset without a broken diagnostic", async () => {
  const headers = new Map([
    ["session-personal", { createdAt: 5, agentPreset: "personal" }],
  ]);
  const { ctx, loader } = await harness(headers);
  ctx.provide("sessionProjections", {
    register: () => () => {},
    stateOf: () => undefined,
  });
  const registry = ctx.plugin(AgentPresetRegistry, { default: "personal" });
  await registry;
  await tick(20);

  const unregister = await ctx.agentPresets.register({
    id: "personal",
    name: "Test",
    plugins: [row("personal")],
  });
  const resolved = await ctx.agentPresets.resolve("personal");
  assert.equal(resolved.id, "personal");
  assert.equal(resolved.broken, undefined, "the registry must not report agent-preset/invalid");

  // The exact path a new Session takes: retain the revision, then bind its
  // scope. This is where the broken mount used to surface as
  // `agent-preset/invalid`.
  const sessionScope = createScope(loader.ctx, {});
  assert.deepEqual(await ctx.agentPresets.mount(sessionScope.ctx, "personal"), { id: "personal" });
  await sessionScope.dispose();

  const composition = await ctx.agentPresets.compositionInventory();
  assert.equal(composition.length, 1);
  assert.equal(composition[0].broken, undefined);
  const spineRow = composition[0].rows.find((entry) => entry.entryId === "spine");
  assert.equal(spineRow?.enabled, true);
  assert.equal(spineRow?.fiberState, 2, "the Spine row is active inside the preset");

  await unregister();
  await tick(20);
  assert.deepEqual(await ctx.agentPresets.compositionInventory(), []);
  await ctx.fiber.dispose();
});
