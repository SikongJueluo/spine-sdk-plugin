/**
 * Host half of the Spine Tree bundle.
 *
 * It registers two authenticated, read-only Fetch routes on the shared API
 * channel and forwards them to the Spine extension's inspection service. This
 * package owns no Spine data: when the extension is absent the routes answer
 * with an explicit "Spine is not enabled" payload, never with an empty tree.
 */
import {
  createSpineRoutes,
  SPINE_REQUEST_PATH,
  SPINE_TREE_PATH,
} from "./host/routes.js";

export const name = "spine-tree";

/** The Connection service carries the Web routes. */
export const inject = ["connection"];

export const SPINE_INSPECTION_SERVICE = "spineInspection";

export function apply(ctx) {
  const routes = createSpineRoutes({
    service: () => {
      const get = ctx.get;
      if (typeof get !== "function") return undefined;
      return get.call(ctx, SPINE_INSPECTION_SERVICE);
    },
    now: () => Date.now(),
  });
  ctx.effect(() => {
    // `fetch.register` returns the disposer itself (a function resolving after
    // removal), not a promise for one.
    const disposers = [
      ctx.connection.fetch.register({
        path: SPINE_TREE_PATH,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: routes.tree,
      }),
      ctx.connection.fetch.register({
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
          if (removal !== null && typeof removal === "object" && typeof removal.then === "function") {
            void removal.catch(() => undefined);
          }
        } catch {
          // Unloading must not fail because one route was already gone.
        }
      }
    };
  }, "spine-tree: read-only inspection routes");
}

