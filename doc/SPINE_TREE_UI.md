# DSH Spine Tree UI

The Web UI companion for the DeepSeek Harness Spine adapter. It adds a third
Conversation View, `Spine Tree`, to the right of `Chat` and `Trajectory`, and is
strictly read-only: opening the view, expanding nodes, selecting requests and
reading evidence never wake an Agent, call a model, move the Spine cursor,
publish context, or write to the Session log or the Spine ledger.

## Scope

**Tree browser** — the live Spine tree of the current Session, with every node
(no `pretty-tree` elision), node status, summary, ordered memory slots, the
execution cursor, and faults. Live Sessions follow committed and published
state; historical Sessions are rebuilt from the Host log plus the plugin-owned
ledger. Missing or corrupt data is reported, never guessed.

**Request audit** — for every model request captured while the plugin runs, the
frozen `llm/stream` `GenerateOptions` is compared with the Spine
`ContextPlan` that was current for that request. The comparison reports
`consistent`, `known differences`, `unexplained differences`, or `insufficient
evidence`, and lists each difference with the plan cell and request message it
refers to.

The audited layer is the **DSH-assembled frozen request**, not the provider
wire: `dsh-llm` still applies config resolution, file/image/tool projections and
adapter replay state after `llm/stream`. Nothing here claims to capture HTTP
bodies, request headers, credentials, or what a provider received.

**Evidence** — captured requests are stored in the plugin-owned
`spine_dsh_audit` domain and survive a restart. They are observations made
after the feature was enabled; a Session without captured evidence reports
`insufficient evidence` rather than a reconstructed request.

## Surface

- `conversation.view` entry `spine-tree`, order `20`, label `Spine Tree`.
- Host routes `GET /api/spine.tree` and `GET /api/spine.request`, authenticated
  by the shared Connection fence. They only read.
- Host plugin `packages/spine-tree` owns the Host-plane `spineInspectionHost`
  broker and registers the routes. A preset-mounted Spine extension contributes
  its per-revision inspection to that broker by calling a method. It does not
  publish a service into the root realm: DSH rejects that as a preset service
  leak (`Preset services require isolate realms`). Without a contributing
  extension the view states that Spine is not enabled instead of rendering an
  empty tree.

## Deployment

- The Web companion is a **Host-plane** bundle. Spine itself stays a **preset**
  plugin: mount `packages/plugin/dist/deepseek-harness/extension.js` in the
  preset that should carry it (for example `personal`), never on the Host
  plane.
- No `isolate` entry for `spineInspection` is required or useful: the extension
  no longer provides that service. An `isolate` realm would only hide a
  contribution from the Host broker.
- The extension works without the Web companion. Its broker lookup is an
  optional nested injection, so a CLI/TUI composition without
  `spineInspectionHost` never leaves the Spine row waiting for a service.
- Every view response, including `unchanged`, names its `source` generation
  next to the numeric `revision`. Clients poll with both; the Host only honors
  `since` when the source matches the selected inspection. A replacement
  revision therefore returns a fresh baseline even when its local counter
  starts at the same number, while ordinary same-source polls still
  short-circuit.
- When more than one preset revision is live, each contributes its own
  inspection. A Session already attached to a revision selects that revision;
  otherwise it is matched by the durable `agentPreset` in its header. Set the
  optional `presetId` config on the Spine row when cold Sessions must be routed
  before any live Session has supplied that identity.
- Both durable domains (`spine_dsh_ledger`, `spine_dsh_audit`) are shared by
  every Spine instance that loads the same extension module and opens them
  through the same storage facility. The handle closes when the last instance
  unloads; `requestRetention` is the largest value any mounted instance
  requested. Do not load two physical copies of the extension in one process:
  the storage facility admits one handle per domain name.
- Each store exposes a per-Session write generation. A reader compares it on
  every view; a write made through another retained revision invalidates the
  cold replay and view snapshots and advances the reader's own revision, so a
  handoff returns the new evidence or ledger state instead of a cached
  baseline.
- Rebuilding the Host plugin does not reload a running process. Restart DSH
  after changing Host code; a page refresh only reloads the Client half.

## Notes and limits

- The request audit cannot prove that a memory summary is semantically
  complete; it checks transmission, order, duplication, anchoring and pairing.
- A retry is a separate captured request. One captured `llm/stream` call is not
  guaranteed to correspond to exactly one HTTP request.
- Requests whose evidence was truncated (> 2 MiB) are marked and audited as
  `insufficient evidence`.
- A missing user-anchor prefix is a known presentation difference. A changed
  anchor number, or an anchor-like prefix on a non-user or non-human message, is
  an unexplained content difference.
- Evidence records written before `planId` existed stay readable; their plan
  version is displayed as unknown instead of the record being treated as
  corrupt.
