/**
 * Host-side registry for the read-only inspections a mounted Agent preset
 * contributes.
 *
 * A preset plugin may not publish a Cordis service into the root realm: DSH
 * rejects that mount as a service leak. The Host Web companion therefore owns
 * this broker and the preset Spine extension registers its inspection here by
 * calling a method. Nothing in this module imports Cordis; the broker is a
 * plain object and its selection policy is exercised directly.
 *
 * One Session must be served by one inspection. A live Session names its
 * revision directly. A historical Session is matched by the `agentPreset`
 * recorded in its durable header; when that is unavailable, an inspection that
 * can prove it owns the Session (its live map, ledger, or audit store) wins.
 * Retained revisions of the same preset share both durable domains, so the
 * most recently mounted (standing) revision reads their historical Sessions.
 * Two different presets with no distinguishing evidence are reported as
 * ambiguous rather than merged into one view.
 */

export const SPINE_INSPECTION_HOST_SCHEMA = "spine.dsh.inspection-host.v1";

/**
 * Distinct per broker process. A browser tab can survive a Host restart; its
 * cursor must not match a new process's first source generation by number.
 */
const SOURCE_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Never reuse a generation within one process, even across broker reloads. */
let sourceSequence = 0;

/**
 * Build one broker.
 *
 * @param {object} [options]
 * @param {(sessionId: string) => Promise<string | undefined>} [options.presetOf]
 *   Reads the durable `agentPreset` of a stored Session without activating an
 *   Agent. The Host plugin supplies this from `sessionController.inspect`.
 * @returns the broker the Host routes and preset contributions use.
 */
export function createSpineInspectionHost(options = {}) {
  const presetOf = typeof options.presetOf === "function"
    ? options.presetOf
    : async () => undefined;
  const contributions = new Set();
  // Wire-cache identity of one registration. A revision number is local to one
  // inspection instance, so a client cursor must name the source generation as
  // well: a replacement revision may legitimately start at the same number.
  const sources = new WeakMap();
  function sourceFor(contribution) {
    let source = sources.get(contribution);
    if (source === undefined) {
      source = `spine-source-${SOURCE_EPOCH}-${++sourceSequence}`;
      sources.set(contribution, source);
    }
    return source;
  }
  // A stored Session header is immutable, so its preset identity is cached.
  // The UI polls once a second; re-reading the whole log on every poll would
  // turn a read-only view into continuous storage I/O. A missing identity is
  // cached briefly so a Session that never joined a preset does not trigger a
  // log read per poll.
  const presetIds = new Map();
  const missingPresets = new Map();
  const MISSING_TTL_MS = 30_000;
  async function cachedPresetId(sessionId) {
    const known = presetIds.get(sessionId);
    if (known !== undefined) return known;
    const until = missingPresets.get(sessionId);
    if (until !== undefined) {
      if (until > Date.now()) return undefined;
      missingPresets.delete(sessionId);
    }
    const value = await safePresetId(presetOf, sessionId);
    if (value !== undefined) {
      if (presetIds.size >= 512) {
        const oldest = presetIds.keys().next();
        if (!oldest.done) presetIds.delete(oldest.value);
      }
      presetIds.set(sessionId, value);
    } else {
      if (missingPresets.size >= 512) {
        const oldest = missingPresets.keys().next();
        if (!oldest.done) missingPresets.delete(oldest.value);
      }
      missingPresets.set(sessionId, Date.now() + MISSING_TTL_MS);
    }
    return value;
  }
  const ok = (contribution) => ({
    kind: "ok",
    contribution,
    source: sourceFor(contribution),
  });

  return {
    schema: SPINE_INSPECTION_HOST_SCHEMA,

    /**
     * Add one inspection. The returned disposer removes exactly that
     * contribution and is idempotent.
     */
    register(contribution) {
      assertContribution(contribution);
      if (contributions.has(contribution)) return () => {};
      contributions.add(contribution);
      sourceFor(contribution);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        contributions.delete(contribution);
        sources.delete(contribution);
      };
    },

    /** Read-only diagnostics: no inspection data leaves this method. */
    describe() {
      return [...contributions].map((contribution) => ({
        id: typeof contribution.id === "string" ? contribution.id : null,
        source: sourceFor(contribution),
        presetId: presetIdOf(contribution) ?? null,
        live: typeof contribution.hasLive === "function",
      }));
    },

    /**
     * Choose the single inspection that may answer for one Session.
     *
     * @returns `{ kind: 'ok', contribution, source }`, `{ kind: 'none', sources }`, or
     *   `{ kind: 'ambiguous', sources, presets }`.
     */
    async select(sessionId) {
      const all = [...contributions];
      if (all.length === 0) return { kind: "none", sources: 0 };

      const live = [];
      for (const contribution of all) {
        if (await safeBoolean(() => contribution.hasLive(sessionId))) live.push(contribution);
      }
      if (live.length === 1) return ok(live[0]);

      const presetId = await cachedPresetId(sessionId);
      if (live.length > 1) {
        const matched = matching(live, presetId);
        if (matched.length === 1) return ok(matched[0]);
        const standing = standingRevision(matched, presetId);
        if (standing !== undefined) return ok(standing);
        return ambiguous(matched.length > 0 ? matched : live);
      }

      if (all.length === 1) {
        const only = all[0];
        const known = presetIdOf(only);
        // A single source is not automatically the owner of every Session: a
        // Session recorded under another preset must not be rendered with
        // this revision's configuration.
        if (presetId === undefined || known === undefined || known === presetId) {
          return ok(only);
        }
        return { kind: "none", sources: 1 };
      }

      if (presetId !== undefined) {
        const matched = matching(all, presetId);
        if (matched.length === 1) return ok(matched[0]);
        if (matched.length > 1) {
          const standing = standingRevision(matched, presetId);
          if (standing !== undefined) return ok(standing);
          return ambiguous(matched);
        }
      }

      const owners = [];
      for (const contribution of all) {
        if (await safeBoolean(() => contribution.owns(sessionId))) owners.push(contribution);
      }
      if (owners.length === 1) return ok(owners[0]);
      if (owners.length > 1) return ambiguous(owners);
      return { kind: "none", sources: all.length };
    },
  };
}

function ambiguous(contributions) {
  const presets = [...new Set(contributions
    .map((contribution) => presetIdOf(contribution))
    .filter((value) => typeof value === "string" && value.length > 0))];
  return {
    kind: "ambiguous",
    sources: contributions.length,
    presets: presets.sort((left, right) => left.localeCompare(right)),
  };
}

function matching(contributions, presetId) {
  if (presetId === undefined) return [];
  return contributions.filter((contribution) => presetIdOf(contribution) === presetId);
}

/**
 * A retired preset revision and its replacement may both be retained while old
 * Agents live. They are the same preset and share both durable domains, so a
 * historical Session is read by the most recently mounted (standing) revision
 * instead of being reported ambiguous.
 */
function standingRevision(contributions, presetId) {
  if (presetId === undefined || contributions.length < 2) return undefined;
  for (const contribution of contributions) {
    if (presetIdOf(contribution) !== presetId) return undefined;
  }
  return contributions[contributions.length - 1];
}

function presetIdOf(contribution) {
  if (typeof contribution.presetId === "function") {
    try {
      const value = contribution.presetId();
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof contribution.presetId === "string" && contribution.presetId.length > 0
    ? contribution.presetId
    : undefined;
}

async function safePresetId(presetOf, sessionId) {
  try {
    const value = await presetOf(sessionId);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function safeBoolean(read) {
  try {
    return (await read()) === true;
  } catch {
    return false;
  }
}

function assertContribution(contribution) {
  if (contribution === null || typeof contribution !== "object") {
    throw new TypeError("Spine inspection contribution must be an object");
  }
  for (const method of ["view", "request"]) {
    if (typeof contribution[method] !== "function") {
      throw new TypeError(`Spine inspection contribution must implement ${method}()`);
    }
  }
  if (contribution.owns !== undefined && typeof contribution.owns !== "function") {
    throw new TypeError("Spine inspection contribution owns must be a function");
  }
  if (contribution.hasLive !== undefined && typeof contribution.hasLive !== "function") {
    throw new TypeError("Spine inspection contribution hasLive must be a function");
  }
}
