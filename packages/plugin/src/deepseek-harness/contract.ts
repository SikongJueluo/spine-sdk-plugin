import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import { SPINE_TOOL_NAMES, type SpineToolName } from "../tools.js";

/** One model-facing DSH tool definition sourced from the core catalog. */
export interface SpineToolContract {
  readonly name: SpineToolName;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** The core-owned model contract for one mounted DSH revision. */
export interface SpineContract {
  /** Core's canonical workflow instruction, addressed to the DSH tool names. */
  readonly rules: string;
  readonly tools: readonly SpineToolContract[];
}

/**
 * Read core's prompt and tool catalog once for a mounted revision.
 *
 * Spine-core owns both texts. The catalog's operation ids are host-neutral
 * (`open`); this adapter maps them onto the registered DSH names and rewrites
 * core's dotted default wording (`spine.open`) to those same names. A supplied
 * `configToml` keeps its own wording when it already uses the DSH names.
 */
export function loadSpineContract(configToml?: string): SpineContract {
  const runtime = createNodeSpineRuntime({
    thread: "dsh-spine-contract",
    features: ["jit", "spawn"],
    ...(configToml === undefined ? {} : { configToml }),
  });
  try {
    const catalog = new Map(runtime.toolCatalog().map((tool) => [tool.id, tool]));
    const tools = SPINE_TOOL_NAMES.map((name): SpineToolContract => {
      const id = name.slice("spine_".length);
      const tool = catalog.get(id);
      if (tool === undefined) {
        throw new Error(`Spine tool catalog has no "${id}" operation for ${name}`);
      }
      return {
        name,
        description: adaptToolNames(tool.description),
        parameters: dshParameters(tool.parameters) as Record<string, unknown>,
      };
    });
    return { rules: adaptToolNames(runtime.extendSystemPrompt("")).trim(), tools };
  } finally {
    runtime.dispose();
  }
}

/**
 * Project core's JSON Schema onto the schema subset DSH accepts for tool
 * parameters. The subset has no numeric constraints, so carry `maxLength` and
 * `minItems` into the parameter description instead of dropping them; core
 * still enforces both when the call executes.
 */
function dshParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dshParameters);
  if (value === null || typeof value !== "object") return value;
  const node = { ...(value as Record<string, unknown>) };
  const limits: string[] = [];
  const maxLength = node.maxLength;
  if (typeof maxLength === "number") {
    limits.push(`Maximum ${maxLength} characters.`);
    delete node.maxLength;
  }
  const minItems = node.minItems;
  if (typeof minItems === "number") {
    limits.push(`At least ${minItems} items.`);
    delete node.minItems;
  }
  for (const [key, nested] of Object.entries(node)) {
    if (nested !== null && typeof nested === "object") node[key] = dshParameters(nested);
  }
  if (limits.length > 0) {
    const description = typeof node.description === "string" ? node.description.trim() : "";
    node.description = [description, ...limits].filter((part) => part.length > 0).join(" ");
  }
  return node;
}

/** Map core's dotted default tool references onto the DSH underscore names. */
function adaptToolNames(value: string): string;
function adaptToolNames(value: unknown): unknown;
function adaptToolNames(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\bspine\.(open|close|next|spawn)\b/g, "spine_$1");
  }
  if (Array.isArray(value)) return value.map(adaptToolNames);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, adaptToolNames(nested)]),
    );
  }
  return value;
}
