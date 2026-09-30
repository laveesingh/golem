# Unreleased — Management CLI scope and list JSON

The management contract is built on the isolated spec branch. These notes do not
claim a main rollout, runtime restart or installed-plugin cutover.

## CLI JSON migration

`golem agent list --json`, `golem team list --json` and `golem session list --json`
return one receipt shape:

```json
{"schema_version":2,"items":[],"resolution":{"scope":"global"}}
```

Existing row fields move into `items`; text tables are unchanged. This is an
intentional CLI JSON shape change. External scripts change array operations from
`.[]` to `.items[]`, and `.map/.find/.some` calls operate on `.items`. Empty lists
retain query-level provenance. There is no per-row or legacy-array output mode.
Dashboard REST roster arrays and MCP readers are not wrapped by this CLI change.

## Scope diagnostics

`golem context` reports explicit selectors, canonical caller membership, actual
inherited pane context and cwd-project evidence. Discovery failures stay visible;
a sufficient explicit target does not require successful caller discovery. Cwd
never chooses a team. Explicit parents constrain exact IDs and names; explicit
team selection does not fall back to a different team.

Applicable management mutations and attach support `--dry-run`. Plans do not
write/import registries, prune history, start native resources or focus UI.
Required capabilities in a plan are not proof that execution completed. Existing
real initialization, protocol, ownership and runtime failures remain failures.
The landed 5.25.1 advisory compatibility behavior is preserved.

Native journeys, full real Pi/Claude acceptance, expanded capability controls and
final source/render/runtime integration remain later spec boundaries. Running
old writers across the teams-v2 cutover is not supported; the lead owns the
deliberate final restart/installation boundary.
