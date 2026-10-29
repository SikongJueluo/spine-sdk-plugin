import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const CLIENT = new URL("../../spine-tree/client.js", import.meta.url);

function loadClient(options = {}) {
  const source = readFileSync(CLIENT, "utf8");
  let definition;
  const React = options.React ?? {
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

/**
 * Exercise the registered view with persistent state slots and a seeded feed.
 * Effects are inert; nested component elements are inspected, not rendered.
 */
function mountView(options = {}) {
  const seedFeed = options.view ?? null;
  const slots = [];
  let slotCursor = 0;
  let rootFn = null;
  let rootProps = null;
  let output = null;

  const React = {
    Fragment: "@@fragment",
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.length === 0 ? null : children.length === 1 ? children[0] : children,
      };
    },
    useState(initial) {
      const index = slotCursor;
      slotCursor += 1;
      if (index === slots.length) {
        slots.push({
          value: index === 0 && seedFeed !== null
            ? { phase: "ready", data: seedFeed, error: null, lastOk: 0, failures: 0 }
            : typeof initial === "function" ? initial() : initial,
        });
      }
      return [slots[index].value, (update) => {
        slots[index].value = typeof update === "function" ? update(slots[index].value) : update;
        render();
      }];
    },
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: () => ({ current: null }),
    useCallback: (callback) => callback,
  };

  function render() {
    slotCursor = 0;
    let element = rootFn(rootProps);
    while (typeof element.type === "function") element = element.type(element.props);
    output = element;
  }

  const module = loadClient({ React });
  let registered = null;
  module.apply({
    effect(callback) {
      const dispose = callback();
      return typeof dispose === "function" ? dispose : () => {};
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (registration, component) => {
        registered = component;
        return () => {};
      },
    },
  });
  assert.equal(typeof registered, "function", "the module must register a conversation.view component");
  rootFn = registered;
  rootProps = { sessionId: options.sessionId ?? "s1" };
  render();
  return {
    tree: () => output,
    setProps(props) {
      rootProps = props;
      render();
    },
    setFeed(payload) {
      slots[0].value = { phase: "ready", data: payload, error: null, lastOk: 0, failures: 0 };
      render();
    },
  };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("\n");
  if (typeof node.type === "function") return "";
  return textOf(node.children);
}

function nodesWhere(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === "string") return out;
  if (Array.isArray(node)) {
    for (const child of node) nodesWhere(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  nodesWhere(node.children, predicate, out);
  return out;
}

function tabsOf(tree) {
  return nodesWhere(tree, (node) => node.props.role === "tab")
    .map((node) => ({ label: textOf(node.children), selected: node.props["aria-selected"] === "true" }));
}

function tabNode(tree, label) {
  const node = nodesWhere(
    tree,
    (candidate) => candidate.props.role === "tab" && textOf(candidate.children) === label,
  )[0];
  assert.ok(node, `missing tab "${label}" in ${JSON.stringify(tabsOf(tree))}`);
  return node;
}

function componentsNamed(tree, name) {
  return nodesWhere(tree, (node) => typeof node.type === "function" && node.type.name === name);
}

function click(node) {
  assert.equal(typeof node.props.onClick, "function", "clicked node must expose onClick");
  node.props.onClick({ stopPropagation() {} });
}

function viewNode(overrides = {}) {
  return {
    id: "n1",
    path: [1, 1],
    parentId: null,
    childIds: ["n2"],
    depth: 0,
    kind: "Task",
    status: "Live",
    summary: "Survey the tree",
    start: 1,
    end: null,
    memory: [],
    cursor: true,
    onCursorPath: true,
    ...overrides,
  };
}

function spineTreeOf(nodes, cursorId) {
  return {
    state: "live",
    evidence: "live",
    note: null,
    thread: "t",
    epoch: 1,
    cursorId,
    cursorPath: [1],
    lastBoundary: 1,
    nodes,
    counts: { nodes: nodes.length, live: 1, opened: 0, closed: 1, compacted: 0, tasks: nodes.length, memory: 0 },
    visibleContext: { count: 0, kinds: {} },
  };
}

function sessionView(sessionId, overrides = {}) {
  return {
    schema: "spine.dsh.view.v1",
    sessionId,
    revision: 1,
    source: `src-${sessionId}`,
    observedAt: 1000,
    host: { available: true, reason: null, message: null },
    spine: spineTreeOf([
      viewNode({ id: `${sessionId}-n1`, childIds: [`${sessionId}-n2`], cursor: true }),
      viewNode({
        id: `${sessionId}-n2`,
        parentId: `${sessionId}-n1`,
        childIds: [],
        depth: 1,
        status: "Closed",
        summary: "Inspect the leaf",
        end: 2,
        cursor: false,
        onCursorPath: false,
      }),
    ], `${sessionId}-n1`),
    activity: { sampling: true, label: null },
    fault: null,
    requests: [],
    evidence: { store: "ok", captured: 0, message: null },
    ledger: { entries: 3, archives: 1, spawnTerminals: 1 },
    ...overrides,
  };
}

function requestSummary(overrides = {}) {
  return {
    id: "r1",
    at: 1234,
    purpose: null,
    attempt: 1,
    provider: "prov",
    model: "model-x",
    messageCount: 2,
    toolCount: 0,
    bytes: 512,
    truncated: false,
    hasPlan: true,
    evidence: "live",
    audit: { status: "consistent", expected: 1, actual: 1, matched: 1, known: 0, unexplained: 0 },
    ...overrides,
  };
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

test("hides the audit surface while no evidence baseline exists, keeping the tree", () => {
  const loading = mountView({ view: null });
  assert.deepEqual(tabsOf(loading.tree()), [{ label: "mode.tree", selected: true }],
    "only the tree tab before the first payload");
  assert.equal(componentsNamed(loading.tree(), "RequestInspector").length, 0,
    "RequestInspector stays unmounted before the first payload");

  const disabled = sessionView("s1", { evidence: { store: "unavailable", captured: 0, message: null } });
  const view = mountView({ view: disabled });
  const tree = view.tree();
  const text = textOf(tree);
  assert.deepEqual(tabsOf(tree), [{ label: "mode.tree", selected: true }],
    "the requests tab is hidden when the store is unavailable");
  assert.equal(text.includes("Survey the tree"), true, "tree nodes stay visible");
  assert.equal(text.includes("Inspect the leaf"), true);
  assert.equal(text.includes("nodeStatus.live"), true, "Live badge stays");
  assert.equal(text.includes("nodeStatus.closed"), true, "Closed badge stays");
  assert.equal(text.includes("▶ cursor"), true, "execution cursor stays");
  assert.equal(text.includes("status.live"), true, "live status pill stays");
  assert.equal(text.includes("footer.ledger"), true, "ledger footer stays");
  assert.equal(text.includes("footer.evidence"), false, "evidence footer is hidden");
  assert.equal(
    componentsNamed(tree, "EmptyState").some((node) => node.props.title === "requests.emptyTitle"),
    false,
    "audit empty state is hidden",
  );
  assert.equal(componentsNamed(tree, "RequestInspector").length, 0,
    "RequestInspector stays unmounted");
});

test("an ok evidence store keeps the audit entry and its empty-state hints", () => {
  const view = mountView({ view: sessionView("s1") });
  let tree = view.tree();
  assert.deepEqual(tabsOf(tree).map((tab) => tab.label), ["mode.tree", "mode.requests"],
    "both tabs are offered when the store is ok");
  assert.equal(textOf(tree).includes("footer.evidence"), true, "evidence footer stays");

  click(tabNode(tree, "mode.requests"));
  tree = view.tree();
  assert.deepEqual(tabsOf(tree), [
    { label: "mode.tree", selected: false },
    { label: "mode.requests", selected: true },
  ]);
  const empty = componentsNamed(tree, "EmptyState")
    .find((node) => node.props.title === "requests.emptyTitle");
  assert.ok(empty, "the audit empty state is shown");
  assert.equal(empty.props.body, "requests.emptyBody");
  assert.equal(empty.props.hint, "requests.captureHint");
});

test("an ok evidence store keeps the request detail entry", () => {
  const view = mountView({
    view: sessionView("s1", {
      revision: 2,
      requests: [requestSummary()],
      evidence: { store: "ok", captured: 1, message: null },
    }),
  });
  let tree = view.tree();
  click(tabNode(tree, "mode.requests"));
  tree = view.tree();
  const row = nodesWhere(tree, (node) => node.props.className === "spt-listRow")[0];
  assert.ok(row, "the request row is listed");
  assert.equal(textOf(row).includes("model-x"), true);
  click(row);
  const inspector = componentsNamed(view.tree(), "RequestInspector")[0];
  assert.ok(inspector, "RequestInspector mounts for a selected request");
  assert.equal(inspector.props.requestId, "r1");
});

test("an errored evidence store stays visible with its error surfaces", () => {
  const view = mountView({
    view: sessionView("s1", {
      evidence: { store: "error", captured: 0, message: "store exploded" },
    }),
  });
  let tree = view.tree();
  assert.deepEqual(tabsOf(tree).map((tab) => tab.label), ["mode.tree", "mode.requests"],
    "an errored store does not hide the audit entry");
  assert.equal(textOf(tree).includes("footer.evidenceError"), true, "evidence error footer stays");

  click(tabNode(tree, "mode.requests"));
  const empty = componentsNamed(view.tree(), "EmptyState")
    .find((node) => node.props.title === "requests.emptyTitle");
  assert.ok(empty, "the audit empty state is shown");
  assert.equal(empty.props.body, "requests.unavailableBody store exploded");
  assert.equal(empty.props.hint, null, "no capture hint for an errored store");
});

test("a session that turns disabled snaps requests mode back to the tree", () => {
  const view = mountView({
    view: sessionView("s1", {
      revision: 2,
      requests: [requestSummary()],
      evidence: { store: "ok", captured: 1, message: null },
    }),
  });
  let tree = view.tree();
  click(tabNode(tree, "mode.requests"));
  tree = view.tree();
  click(nodesWhere(tree, (node) => node.props.className === "spt-listRow")[0]);
  assert.ok(componentsNamed(view.tree(), "RequestInspector")[0],
    "RequestInspector is mounted in requests mode");
  assert.equal(view.tree().props["data-pane"], "detail", "the request detail pane is open");

  view.setProps({ sessionId: "s2" });
  tree = view.tree();
  assert.deepEqual(tabsOf(tree), [{ label: "mode.tree", selected: true }],
    "the tree is active before the new session's payload arrives");
  assert.equal(componentsNamed(tree, "RequestInspector").length, 0,
    "a stale enabled payload cannot mount RequestInspector for the new session");
  assert.equal(tree.props["data-pane"], "list",
    "the pane falls back to the list so the tree stays reachable on narrow layouts");

  view.setFeed(sessionView("s2", {
    spine: spineTreeOf([viewNode({ id: "s2-m1", summary: "Second session task", childIds: [] })], "s2-m1"),
    evidence: { store: "unavailable", captured: 0, message: null },
  }));
  tree = view.tree();
  const text = textOf(tree);
  assert.deepEqual(tabsOf(tree), [{ label: "mode.tree", selected: true }],
    "the tree tab is selected again immediately");
  assert.equal(text.includes("Second session task"), true, "the new session's tree is rendered");
  assert.equal(componentsNamed(tree, "RequestInspector").length, 0,
    "RequestInspector unmounts without mounting a fetch");
  assert.equal(
    componentsNamed(tree, "EmptyState").some((node) => node.props.title === "requests.emptyTitle"),
    false,
    "no audit empty state is offered",
  );
  assert.equal(text.includes("footer.evidence"), false, "evidence footer is hidden");
  assert.equal(text.includes("footer.ledger"), true, "ledger footer stays");
  click(nodesWhere(tree, (node) => node.props.role === "treeitem")[0]);
  assert.equal(view.tree().props["data-pane"], "detail",
    "selecting a tree node still opens its detail pane after the audit fallback");
  assert.equal(textOf(view.tree()).includes("Second session task"), true);
  assert.equal(componentsNamed(view.tree(), "RequestInspector").length, 0);
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
