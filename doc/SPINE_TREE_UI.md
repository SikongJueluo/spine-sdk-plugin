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
- Host plugin `packages/spine-tree` registers the routes and asks the Spine
  extension for a read-only inspection service (`spineInspection`). Without the
  extension the view states that Spine is not enabled instead of rendering an
  empty tree.

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
