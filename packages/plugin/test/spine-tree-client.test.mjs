import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const CLIENT = new URL("../../spine-tree/client.js", import.meta.url);

function loadClient() {
  const source = readFileSync(CLIENT, "utf8");
  let definition;
  const React = {
    createElement: () => null,
    Fragment: "fragment",
    useState: (value) => [typeof value === "function" ? value() : value, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: () => ({ current: null }),
    useCallback: (callback) => callback,
  };
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value;
        },
      },
    },
    document: {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    Date,
    JSON,
    Map,
    Set,
    Number,
    String,
    Array,
    Object,
    Math,
    console,
  });
  vm.runInContext(source, context);
  assert.ok(definition, "client.js must register a module loader definition");
  assert.equal(definition.id, "@spinejit/dsh-spine-tree");
  const module = definition.factory((request) => {
    if (request === "react") return React;
    throw new Error(`unexpected module request: ${request}`);
  });
  return module;
}

test("the client bundle registers one lazy factory and one Conversation View", () => {
  const module = loadClient();
  assert.deepEqual([...module.inject], ["slots", "locale"]);

  const calls = [];
  const ctx = {
    effect(callback, label) {
      calls.push(["effect", label]);
      const dispose = callback();
      return typeof dispose === "function" ? dispose : () => {};
    },
    locale: {
      register(namespace, dictionaries) {
        calls.push(["locale.register", namespace, dictionaries]);
        return () => {};
      },
      bind(namespace) {
        calls.push(["locale.bind", namespace]);
        return (key) => key;
      },
    },
    slots: {
      inject(name, callback) {
        calls.push(["slots.inject", name]);
        callback();
      },
      register(options, component) {
        calls.push(["slots.register", options, component]);
        return () => {};
      },
    },
  };
  module.apply(ctx);

  const dictionaries = calls.find((call) => call[0] === "locale.register");
  assert.equal(dictionaries[1], "spine-tree");
  assert.deepEqual(Object.keys(dictionaries[2]).sort(), ["en", "zh"]);
  assert.equal(typeof dictionaries[2].en["view.label"], "string");
  assert.equal(
    Object.keys(dictionaries[2].en).length,
    Object.keys(dictionaries[2].zh).length,
    "both locales must cover the same keys",
  );

  const injection = calls.find((call) => call[0] === "slots.inject");
  assert.equal(injection[1], "conversation.view");
  const registration = calls.find((call) => call[0] === "slots.register");
  assert.equal(registration[1].name, "conversation.view");
  assert.equal(registration[1].id, "spine-tree");
  assert.equal(registration[1].order, 20);
  assert.equal(registration[1].locale, "spine-tree");
  assert.equal(registration[1].label(), "view.label");
  assert.equal(typeof registration[2], "function", "the view must register a component");
});

test("the host bundle provides the inspection broker and registers two read-only routes", async () => {
  const host = await import("../../spine-tree/index.js");
  let provided;
  let injectedDeps;
  let registered = 0;
  let disposed = 0;
  const disposers = [];
  const ctx = {
    get: () => undefined,
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === "function") disposers.push(dispose);
      return () => {};
    },
    provide(name, value) {
      provided = { name, value };
      return () => {};
    },
    inject(deps, callback) {
      injectedDeps = deps;
      callback({
        get(name) {
          return name === "spineInspectionHost" ? provided?.value : undefined;
        },
        effect(callback2) {
          const dispose = callback2();
          if (typeof dispose === "function") disposers.push(dispose);
          return () => {};
        },
        connection: {
          fetch: {
            register(route) {
              registered += 1;
              assert.deepEqual(route.methods, ["GET"]);
              assert.equal(route.requestBody, "buffered");
              assert.match(route.path, /^\/api\/spine\./);
              return () => {
                disposed += 1;
                return Promise.resolve();
              };
            },
          },
        },
      });
    },
  };
  host.apply(ctx);
  assert.equal(host.inject, undefined, "the Web companion must not wait for a connection");
  assert.equal(provided.name, "spineInspectionHost");
  assert.equal(provided.value.schema, "spine.dsh.inspection-host.v1");
  assert.deepEqual(injectedDeps, ["connection"]);
  assert.equal(typeof provided.value.select, "function");
  assert.equal(registered, 2);
  for (const dispose of disposers) dispose();
  assert.equal(disposed, 2);
});
