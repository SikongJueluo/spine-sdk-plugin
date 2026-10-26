/**
 * Process-local leases for the two Spine durable domains.
 *
 * The DSH storage facility allows one open handle per domain name. Spine can
 * have more than one live extension instance in one process: two presets may
 * enable it, and a retired preset revision stays alive while an Agent still
 * retains it. Every instance must nevertheless read and write the same ledger
 * and audit domain, so leases are keyed by the storage-facility object and
 * reference counted. The last release closes the domain; a later lease reopens
 * it. Open and close run on one per-domain queue, so a revision that unloads
 * while its replacement mounts never races the single-open rule.
 */
import type {
  DeepSeekHarnessRequestStore,
} from "./requests.js";

export interface DeepSeekHarnessStoreLease<T> {
  /**
   * The shared handle. Every lease on one `kind` for one facility observes the
   * same store generation; it rejects only when the underlying open failed.
   */
  readonly store: Promise<T>;
  /** Drop this lease; the last one closes the handle. Idempotent. */
  release(): Promise<void>;
}

interface SharedEntry {
  /** Current open generation, or null while closed or opening the next one. */
  store: Promise<unknown> | null;
  refs: number;
  /** Serializes open and close transitions for this domain. */
  lock: Promise<void>;
}

const hubs = new WeakMap<object, Map<string, SharedEntry>>();

function hubFor(owner: object): Map<string, SharedEntry> {
  let hub = hubs.get(owner);
  if (hub === undefined) {
    hub = new Map();
    hubs.set(owner, hub);
  }
  return hub;
}

function entryFor(owner: object, kind: string): SharedEntry {
  const hub = hubFor(owner);
  let entry = hub.get(kind);
  if (entry === undefined) {
    entry = { store: null, refs: 0, lock: Promise.resolve() };
    hub.set(kind, entry);
  }
  return entry;
}

/**
 * Lease one durable store shared by every Spine extension instance that opens
 * it through the same storage facility.
 *
 * @param owner - identity of the open-domain table; the storage facility.
 * @param kind - domain name (one handle per name).
 * @param open - opener for the next generation. Later leases reuse it.
 */
export function leaseSharedStore<T extends { close(): Promise<void> }>(
  owner: object,
  kind: string,
  open: () => Promise<T>,
): DeepSeekHarnessStoreLease<T> {
  const entry = entryFor(owner, kind);
  const acquired = entry.lock.then(async () => {
    if (entry.store === null) {
      const created: Promise<unknown> = Promise.resolve().then(open).catch((error: unknown) => {
        // A failed generation is not retained: the next lease retries. Leases
        // that already hold this promise still observe the failure.
        if (entry.store === created) entry.store = null;
        throw error;
      });
      entry.store = created;
    }
    entry.refs += 1;
    return entry.store as Promise<T>;
  }).then((store) => store);

  let released = false;
  return {
    store: acquired,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const previous = entry.lock;
      let settle!: () => void;
      entry.lock = new Promise<void>((resolve) => { settle = resolve; });
      await previous;
      try {
        entry.refs -= 1;
        if (entry.refs > 0) return;
        const opened = entry.store;
        entry.store = null;
        const value = await opened?.catch(() => undefined) as T | undefined;
        if (value !== undefined) await value.close().catch(() => undefined);
      } finally {
        settle();
      }
    },
  };
}

/**
 * Lease the request-evidence store, whose per-Session retention is part of the
 * shared configuration.
 *
 * The first lease opens with its own value; every later lease raises the open
 * store to the largest value any mounted Spine instance asked for. Retention
 * never shrinks while the shared handle lives, because a lower value must not
 * prune records another preset still expects to read.
 */
export function leaseSharedRequestStore(
  owner: object,
  open: (retention: number) => Promise<DeepSeekHarnessRequestStore>,
  retention: number,
): DeepSeekHarnessStoreLease<DeepSeekHarnessRequestStore> {
  const wanted = normalizedRetention(retention);
  const lease = leaseSharedStore(
    owner,
    "spine_dsh_audit",
    () => open(wanted),
  );
  void lease.store.then((store) => {
    store.setRetention(wanted);
  }).catch(() => undefined);
  return lease;
}

export function normalizedRetention(retention: number): number {
  if (!Number.isFinite(retention)) return 1;
  return Math.max(1, Math.trunc(retention));
}
