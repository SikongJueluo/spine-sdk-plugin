# Ownership Boundary

## Shared product

The WASM runtime owns identity allocation, typed fact admission, ordering,
reduction, archive validation, replay, namespace continuation, and canonical
context plans. The shared controller owns the persist-before-install protocol,
fault latch, schema checks, and recovery orchestration.

## Host adapters

Each adapter owns only typed host-event mapping, source-message transport,
durable append and flush, ContextPlan materialization, lifecycle wiring, UI,
context and compaction exclusivity, cancellation, and child execution policy.

Pi's history tree and DeepSeek Harness's session lineage remain distinct from
the Spine scope tree. Neither adapter may infer Spine facts from rendered text,
tool prose, UI state, or native tool grouping.

Pi owns native `AgentMessage` transport outside the semantic core and binds it
to core-assigned `SourceCellId` values. The extension is the final context
publisher and intercepts native compaction. It persists a Spine compact barrier
and replacement messages, publishes the replacement context, and accepts the
following Pi compaction entry only as an acknowledgement of that barrier.
Recovery additionally requires that adjacent native entry to carry Pi's
`fromHook: true` ownership marker. The before-hook abort signal faults the live
session if Pi aborts after the Spine transaction has already completed.

Two recovery capabilities are intentionally not simulated:

- an uncommitted durable Spawn terminal batch requires a Pi API that can
  restore/finalize the native parent tool result after restart.

Both cases fail closed. They are host integration gates, not alternate semantic
paths.

DeepSeek Harness publishes one model-visible surface derived from its own event
log. It has no zero-to-many-message projection event and no out-of-repo session
event vocabulary: extension records live in a plugin-owned
`ctx.storageDomain` ledger, while context changes are compiled into native
message events with `surfaceOp: { op: 'replace' }` plus appends. The adapter
owns the differential publisher, the durable ledger, replay ordering at the
recorded session cut, and fail-closed durability checks after every append
batch. The host still owns the system prompt, tool history, request assembly,
and session persistence.

The loadable DSH extension requires a composition with no native compaction
provider. That is a deployment constraint, not a host capability claim: Spine
replaces the model context, so a second context reducer cannot run beside it.
Successful `step/end` is a pending boundary, not an immediate commit;
PostSampling runs at the awaited next `agent/pre-step` or
`agent/turn-stopping`, so an exceptional request or turn boundary can still
select the correct failed/cancelled terminal.
