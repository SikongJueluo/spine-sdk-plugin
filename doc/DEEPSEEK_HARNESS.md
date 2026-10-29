# DeepSeek Harness adapter

Status: **DSH `0.2.0-rc.2` only.** The adapter is built against the real
`@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`, and
`@deepseek-ai/dsh-tools` type surfaces pinned as dev dependencies. A host
upgrade must re-check those types and rerun `test/dsh-real-host.test.mjs`;
there is no compatibility claim for `0.2.1-rc.x` or later.

## What the host actually provides

- `Session` has `snapshotEvents()` and the live `surface`; it has no `events`
  property and no `SessionStore.registerRequiredEventOwner`.
- `SessionStore.flush(session)` returns whether at least one durability
  listener participated and throws the first listener failure.
- Session event types are a build-time vocabulary. An out-of-repo plugin cannot
  register a new type, and `Session.append()` cannot set `ignorable`, so
  `spine/*` records are not a durable option.
- `surfaceOp: { op: 'replace', startSeq, endSeq }` is the public native way to
  replace a contiguous surface range. Node 0 may hold the system prompt, and it
  may only be replaced by a `system/message` covering exactly that node.
- `ctx.storageDomain` is the public plugin-data store. A per-record write
  resolves after backend durability.
- `SessionStore.fork()` copies a prefix of the parent log; the private ledger
  is not forked automatically.

## Model-facing contract

The adapter consumes the SDK's single source of truth instead of maintaining a
parallel catalog:

- `runtime.extendSystemPrompt("")` supplies the canonical workflow policy and
  `runtime.toolCatalog()` supplies each tool description and parameter schema.
  Operation ids (`open`, …) map onto the registered `spine_*` names; core's
  dotted default references (`spine.open`) are rewritten to those names. With
  no `configToml`, the installed core default and `packages/plugin/spine.toml`
  are identical after that mapping.
- A scoped `systemPrompt.section` (`tool:spine`) renders the policy only while
  all four tools are visible in the assembling scope. A restriction, a
  disabled or unmounted preset, and plugin unload remove it with the tools.
  It adds about 2.0k characters (roughly 500 tokens) per enabled request.
- DSH's tool-parameter schema subset has no `maxLength` or `minItems`. The
  adapter moves those constraints into the parameter description instead of
  dropping them; the core still enforces both at execution.
- The existing `<spine_node>` and `<spine_memory>` ContextPlan projections
  remain the scope state the model reads. The adapter adds no second
  "current branch" context.

Admission uses the recovered or last committed projection cursor:

- `spine_close` and `spine_next` at root return an ordinary erroneous tool
  result with corrective text instead of a lifecycle fault.
- One `spine_open`, `spine_close`, `spine_next`, or `spine_spawn` per model
  response is admitted. A second transition gets an erroneous result and is
  never staged; the core would otherwise accept the stage and fail the whole
  sampling when it commits.
- `execute()` and the `tool/call` event path share one admission record, so a
  call cannot be staged twice and an aborted call leaves no execution.

## Durable layout

Domain `spine_dsh_ledger`, version `1`, layout `per-record`, one table
`entries`. Each record is one journal entry:

```text
schema:          "spine.dsh.ledger.v1"
sessionId
sessionCreatedAt  host header identity; a reused id with another lifecycle fails
ordinal           monotonic per session
anchorSeq         session.seq when the entry became durable
kind              "archive" | "spawn-terminal"
archive?          { schema, durabilityId, record: sampling_started|sampling_commit }
batchId?/result?  spawn terminal staging
```

Records are authoritative: an unreadable record rejects the whole domain open
instead of being skipped. The adapter flushes the host session log before each
archive record, then writes the record before the controller installs the
prepared operation. A crash can therefore leave source events without an
archive (replayed as sources, with a fresh sampling attempt) but never an
archive whose cited sources are missing.

## Sampling ownership

`llm/stream` wraps every streaming model call, not only the agent loop's step
requests; `agent/pre-step`, `agent/request-error`, and `agent/turn-stopping` are
the agent-loop boundaries. A request joins the Session's main sampling
transaction only when it is the loop's own: same Session id, no auxiliary
`purpose`, no top-level `system`, and the rendered prompt as the leading
system-role message. Hand-built one-shot calls that borrow the Session id for
routing — the auto-permit approval judge, a search planner — are forwarded to
their provider untouched: they begin, settle, audit, or fault nothing, so a
failed judge cannot latch a lifecycle fault. The leading-system clause assumes
the loop renders the effective prompt as its first message; a Spine-enabled
preset always contributes a non-empty prompt, so its requests satisfy it, while
a prompt-less request is not admitted to main sampling. The
`markAgentLoopRequest` identity is not usable as a cross-package proof: it is a
`WeakSet` private to one `@deepseek-ai/dsh-llm` module instance, and a
separately loaded plugin resolves its own copy, which never contains the Host
loop's marked request. A same-session request that does satisfy the loop
contract while a sampling is active is a real re-entry and still faults.

## Context publication

At `agent/pre-step` the adapter waits for the waterfall decision, admits the
**accepted** `decision.messages` before the loop logs them, previews the plan,
and returns the messages unchanged. If `next()` replaces an id or
its content, the replacement is authoritative; the claimed payload is never
substituted back. The loop logs that original content, and the human transcript
renders append-origin events, so the request built from the returned messages
carries exactly what the user typed; `llm/stream` never rewrites a frozen
request. A prior-portion publication may not land at pre-step: session format
v4 admits coordinate-carrying publication events (developer/system messages,
assistant/tool copies) only inside an open step, so the publisher defers
them and they converge at the next in-step (sampling-finish) publication —
the first request after a divergence serves the logged surface as-is. Only human inputs (`source.kind: 'user'`) receive a Spine user anchor,
and the anchor is model-only: the next publication replaces the logged input's
surface node with its anchored copy through the native `surfaceOp: replace`
protocol, which never touches the transcript (replacement copies stay
model-only). The first request after an input therefore carries no anchor;
every later request does. Other legal user-role producers (`goal`,
`agent-message`, auto-continue, runtime context) remain contextual sources,
keep their producer-owned source through replay, and never receive an anchor.
The anchored copy stores its pre-anchor content in the message source
(`spineInput`), so replay observes the same source content and does not
double-anchor. The field lives only in `Message.source`; the DeepSeek wire
formatter serializes role/content, and other provider adapters must keep source
non-model-facing. If the loop
never logs a pre-admitted input, the lifecycle faults instead of continuing
with state the log cannot reconstruct. A failure during pre-admission discards
that session's runtime/state; the next pre-step rebuilds it from the host log
and durable ledger, so a candidate the host never accepted cannot leak into a
later request. The publisher also refuses to publish a source message without a
host-accepted event, and a plan copy written by the adapter is never treated as
acceptance evidence.

The publisher materializes the Spine `ContextPlan` into real DSH messages, then:

1. Keeps node 0 when it is the host system prompt.
2. Keeps the longest content-equal prefix and suffix.
3. When the middle of the plan is exactly one non-assistant message, replaces
   the divergent middle range with it in one native replacement. This is the
   normal compaction shape (a summary or memory cell) and keeps the surviving
   assistant/tool tail's original surface nodes.
4. Otherwise appends one empty `developer/message` with
   `source.kind: "spine-context"` and `surfaceOp: replace` over the divergent
   range. Empty developer content derives no model-visible message, so it is
   only a deletion carrier.
5. Appends the remaining planned messages in order:
   - user: `user/message`, preserving producer-owned `source`;
   - assistant: `assistant/message` with the original durable `stream`,
     `usage`, and `interrupted` payload;
   - tool: `tool/result` with the original `error` and `meta`;
   - developer/system: only when they came from a host event.
   Every coordinate-carrying copy carries the currently open turn/step (the
   loader's `requireStep` rule), never its origin's coordinates.
6. Awaits `SessionStore.flush()` and fails the session when no listener
   participates.

Unchanged plans return without appending. A publication invoked while no
step is open (recovery replay, pre-step preview) writes nothing and converges
at the next in-step publication instead — session format v4 would otherwise
reject the log at load time as corrupt. Derived messages carry
`source.kind: "spine-context"`; published copies keep their original message
identity, so replay can skip every copy after the first occurrence.

Known limits of this representation:

- A tool result is only published when its assistant tool-call is already in
  the target.
- A plan that places derived cells after the current input cannot be split into
  "prior context" plus "current input"; the adapter fails closed before request
  assembly instead of sending an inconsistent request.
- A replacement cannot be an assistant message. A plan that inserts more than
  one message before a surviving tail therefore replaces the whole divergent
  range and re-appends the tail; the original append-origin events stay in the
  human transcript, while those copies are model-only surface nodes.
- In-history system updates are host-owned. They are kept only while they fall
  inside the unchanged prefix; later ones are shadowed, and the host's
  `SystemPromptProjection` repairs the head on the next step.
- The log grows by the appended suffix when a plan changes. Normal steps are
  no-ops, but a compacting plan re-appends the surviving tail.

## Recovery

At the awaited pre-step (or turn-stopping) boundary the adapter:

1. snapshots the host log and reads ledger entries for the session identity;
2. merges source observations and archives by `(anchorSeq, ordinal)`, with the
   archive before the source at the same cut;
3. skips system/developer messages, derived `spine-context` messages, and any
   message identity already seen (published copies);
4. replays the canonical Spine state and installs source bindings;
5. republishes only if the current derived history differs from the replayed
   plan.

Events appended while recovery is running are admitted afterwards unless they
are below the replay cut or published by the adapter itself. A fork keeps its
recorded runtime thread, continues the namespace for the child, and publishes
the replayed plan. Before replay, the child copies every parent journal whose
`anchorSeq <= inheritedEventCount` into its own ledger (idempotently, by
durability identity), so a later recovery does not depend on the parent ledger
surviving. If the parent ledger was already deleted before the child's first
recovery, only the inherited message sources are replayed; the child cannot
reconstruct the parent's semantic journal. A cut inside an open sampling keeps
the parent's `sampling_started` but not its future commit; the core discards
the uncommitted attempt and the child starts a fresh one.

## Composition requirements

- `storageDomain` must be mounted (`@deepseek-ai/dsh-storage-domain` plus a
  backend). The default `dsh-base` composition mounts it.
- The session must have a durability listener; the JSONL session persistence
  plugin provides one.
- **No native compaction provider.** `compaction-basic`, the `/compact` command
  plugin (it injects the compaction service), and any competing context reducer
  must be removed from the Spine-enabled profile.
- The adapter fails closed when either requirement is missing.

## Migration and removal

The released `0.1.0` adapter could not durably produce `spine/*` events: the
host persistence reader rejects unknown non-ignorable types, and the adapter
placed its projection in an event that DSH never applied. A session written by
an experimental build that does contain `spine/*` events is unreadable by the
current host; there is no automatic migration.

Removing the extension leaves an ordinary DSH session log. It does **not** carry
the Spine ledger: the host export contains session events only. A complete
transfer needs a bundle of the session log plus the `spine_dsh_ledger` storage
domain; that export/import command is not implemented yet. Do not resume a
Spine-managed session in a plain DSH composition and expect Spine semantics:
the native messages remain readable, but pending projections and archives are
not reconciled.

Within one process, ledger writes for a session run on one chain: ordinal
allocation, duplicate detection, the durable `put`, and the in-memory commit
happen in that order, so concurrent child terminals cannot overwrite the same
journal key. A failed write consumes no ordinal and leaves memory unchanged.

Concurrent writers to one session across processes are not supported. One
process owns a live session; the ledger has no cross-process compare-and-swap.
Do not share a writable DSH home between a live CLI and Web process for the
same session.

## Web inspection UI

`packages/spine-tree` bundles the `Spine Tree` Conversation View and the two
read-only routes it reads. Its Host half owns the `spineInspectionHost` broker,
registers `GET /api/spine.tree` and `GET /api/spine.request`, and renders an
explicit "Spine is not enabled" state when no preset contributes an inspection.

A preset-mounted Spine extension contributes to that broker when its `inspect`
config is not `false`. The contribution is a method call on a Host service, not
a root-realm `provide`: a preset plugin that publishes a service makes DSH
reject the whole preset with `agent-preset/invalid: Preset services require
isolate realms`. The extension still works when the Web companion is absent;
the optional nested injection simply never activates. It captures frozen loop
requests only when `requestAudit: true` is explicitly configured. Request audit
is off by default: no request snapshots or comparisons are made, and existing
`spine_dsh_audit` data is not opened. The browser hides the request-audit tab
and evidence footer while the Spine Tree, node statuses, cursor, and faults
remain available (`inspect` still defaults to enabled). Disabling audit does
not delete existing evidence or affect `spine_dsh_ledger` recovery.

Tree responses carry a per-registration `source` generation beside the local
numeric `revision`. The client sends both; the Host honors `since` only for the
same source, so a replacement preset revision returns a fresh baseline even
when its counter starts at the same value. The ledger and evidence stores also
expose a per-Session write generation: a view invalidates its cold replay and
snapshot when another retained revision has persisted evidence or ledger
entries, and advances its own revision.

Captured request evidence lives in the `spine_dsh_audit` domain (retention:
`requestRetention`, default 100 per session) and never enters the session log or
`spine_dsh_ledger`. Both durable domains are shared by every live Spine
instance that opens them through the same storage facility, so two presets or a
retired revision do not race the single-open rule; the last unload closes them.
See [SPINE_TREE_UI.md](SPINE_TREE_UI.md) for routing between preset revisions,
the read-only guarantee, the audited layer, and the known limits.
