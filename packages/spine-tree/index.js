/**
 * Host half of the Spine Tree bundle.
 *
 * It owns a small inspection broker and registers two authenticated, read-only
 * Fetch routes on the shared API channel. A mounted Agent preset contributes
 * its per-revision inspection to the broker by calling a method; it does not
 * publish a service into the Host realm, because DSH rejects such a mount as a
 * preset service leak. This package owns no Spine data: when no preset
 * contributes an inspection the routes answer with an explicit "Spine is not
 * enabled" payload, never with an empty tree.
 */
import {
  createSpineInspectionHost,
  SPINE_INSPECTION_HOST_SCHEMA,
} from "./host/broker.js";
import {
  createSpineRoutes,
  SPINE_REQUEST_PATH,
  SPINE_TREE_PATH,
} from "./host/routes.js";

export const name = "spine-tree";

/**
 * Host service name the preset extension contributes to. The extension reads
 * it through an optional nested injection, so a CLI/TUI composition without
 * this Web companion never waits for it.
 */
export const SPINE_INSPECTION_HOST_SERVICE = "spineInspectionHost";

export { SPINE_INSPECTION_HOST_SCHEMA };

export function apply(ctx) {
  const broker = createSpineInspectionHost({
    // Read the durable preset identity of a stored Session without activating
    // its Agent. `sessionController.inspect` is the cold read path.
    presetOf: async (sessionId) => {
      const controller = getService(ctx, "sessionController");
      if (controller === undefined || controller === null ||
        typeof controller.inspect !== "function") {
        return undefined;
      }
      try {
        const found = await controller.inspect(sessionId);
        const preset = found?.meta?.agentPreset;
        return typeof preset === "string" && preset.length > 0 ? preset : undefined;
      } catch {
        return undefined;
      }
    },
  });

  // Host-plane service: every mounted preset may contribute. This is a plain
  // registry contribution, not a preset service registration.
  ctx.provide(SPINE_INSPECTION_HOST_SERVICE, broker);

  ctx.inject(["connection"], (connectionCtx) => {
    const routes = createSpineRoutes({
      service: () => connectionCtx.get(SPINE_INSPECTION_HOST_SERVICE),
      now: () => Date.now(),
    });
    connectionCtx.effect(() => {
      // `fetch.register` returns the disposer itself (a function resolving
      // after removal), not a promise for one.
      const disposers = [
        connectionCtx.connection.fetch.register({
          path: SPINE_TREE_PATH,
          methods: ["GET"],
          requestBody: "buffered",
          fetch: routes.tree,
        }),
        connectionCtx.connection.fetch.register({
          path: SPINE_REQUEST_PATH,
          methods: ["GET"],
          requestBody: "buffered",
          fetch: routes.request,
        }),
      ];
      return () => {
        for (const dispose of disposers) {
          try {
            const removal = dispose();
            if (removal !== null && typeof removal === "object" &&
              typeof removal.then === "function") {
              void removal.catch(() => undefined);
            }
          } catch {
            // Unloading must not fail because one route was already gone.
          }
        }
      };
    }, "spine-tree: read-only inspection routes");
  });
}

function getService(ctx, name) {
  const get = ctx.get;
  if (typeof get !== "function") return undefined;
  return get.call(ctx, name);
}
