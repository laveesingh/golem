# 5.26.0 preparation — predictable local management

Built on `feat/management-contract`; this does not claim main rollout, an
installed-plugin update or full real-harness acceptance. The lead approved source
**5.26.0** and isolated artifact preparation; shared cutover remains gated.

## CLI JSON migration

`agent list --json`, `team list --json` and `session list --json` return:

```json
{"schema_version":2,"items":[],"resolution":{"scope":"global"}}
```

Existing row fields move into `items`; text tables are unchanged. Scripts change
`.[]` to `.items[]`; `.map/.find/.some` operate on `.items`. Empty receipts retain
query provenance. No legacy-array mode is provided. REST/MCP roster arrays remain
arrays.

## Scope and controls

`context` reports explicit selectors, canonical membership, inherited native pane
and cwd-project evidence. Discovery failure remains diagnostic; a sufficient
explicit target does not require caller discovery. Cwd never chooses a team.
Explicit parents constrain exact IDs/names; explicit team never falls back to
another team. Dry-runs do not import/write/prune/start/focus.

Session start/adopt/inspect/stop/close have distinct, repeatable semantics. Stop
retains definitions; restarting a container does not promise the old conversation.
Team logical membership is separate from native placement and role. Rename keeps
stable native handles; leave cannot resurrect from worker cache. Move consumes
actual returned pane/tab/workspace IDs and does not implement cross-server
migration. Closing an old team retains transferred/unmanaged activity.

Per-control `available/unavailable/unsupported` states and recovery are separate
from delivery readiness. Known external agents in Herdr can be controllable;
external alone does not mean outside Herdr. PID/name/group labels alone are not
conversation ownership. Exact native locator and application incarnation are
required; conflicting current identity, probe failure and ambiguous owners refuse.
Pi's in-process typed lease supplies app PID/birth, not Claude MCP sidecar identity.
The standard Herdr reporter owns native reporting; no second automatic Golem
reporter is added. Disabled integration may honestly lack native controls.

## Import, uncertainty and rollback

Evidence reads project legacy relationships without writing. The first management
mutation imports teams-v2 and stored native associations under the short
incarnation-owned lock. `management-backup-v2/manifest.json` and snapshots retain
original bytes/checksums/schema versions privately (mode0600); retries preserve
that original backup. Consistent projects import independently; conflicting exact
handles/membership stay diagnostic and need explicit corrective adoption/selection.
Never choose a workspace by matching its display label.

Pending native operations retain generation/operation identity. Indeterminate
create/move outcomes require exact reconciliation/adoption, not guessed relaunch,
duplicate move or age-based lock stealing. Publication is revalidated after native
work; no native wait runs inside the synchronous lock.

Do not mix old writers with teams-v2 writers. Before new operations, the lead can
stop writers and restore the private original snapshots with the old source/runtime.
After new operations, restoring snapshots alone loses new membership/placement:
stop writers, inventory retained native resources, preserve new records and
reconcile exact associations before selecting a rollback. Do not kill active teams
or treat native resources as disposable migration cleanup.

## Evidence and remaining limits

Isolated real Pi0.99.1 TUI/model/bash plus human shell prove caller/cwd/logical
transfer/native move, nonfocused inherited context, explicit target under missing
caller, populated dashboard/CLI/MCP parity and actual read/adopt/rename/move/stop.
Owned PTY attachment renders the actual Pi screen; disconnecting only the client
leaves the app usable. This is observed same-locator behavior, not all keyboard
navigation, reporter arbitration, in-memory or session-switch guarantees.

Actual Claude2.1.286 remains unverified in private configuration:
`Not logged in · Please run /login`. Full default real-harness acceptance requires
supported authentication or an explicit human scope decision. Fake harness/native
journeys are separate evidence, never a substitute. The landed 5.25.1 advisory
version/provider behavior remains; actual protocol/init/execution failures fail.

## Lead-owned landing checklist

1. Resolve Claude acceptance; version5.26.0 is approved. Obtain fresh complete review and
   separate verification. Retain an explicit ran/failed/not-run matrix.
2. Land from the spec branch, preserve original active-team definitions/backups and
   arrange a deliberate mixed-writer cutover. Report any required disruptive restart.
3. From landed main only: verify approved source/lock version5.26.0, sync cc workspace render and
   `plugin/` round-trip; sync Pi only when its source bundle is safe. Source render
   refresh is not the installed plugin update.
4. Update/reload installed plugin; restart the dashboard from landed main after
   stopping old writers. Plugin reload alone does not restart channel MCP processes.
5. Smoke actual installed human/Pi/Claude context, real roster/control/delivery and
   an occurrence receipt/correlated ACK; verify existing teams survived. No live
   migration, global render/restart or human-session teardown from a worktree.
