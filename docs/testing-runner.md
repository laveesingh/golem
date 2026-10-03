# W2 runner and incremental checks

W0 source inventory is `docs/testing-inventory.md` (baseline 20a5cf5). W1/W2 extend that census; eligibility is not pass evidence.

## Commands and layers

| Command | Boundary |
| --- | --- |
| `npm run check` | isolated Biome + strict TypeScript + exact Knip debt comparison + native backend import; every check reports its exit |
| `npm test` / `npx vitest run --project unit --project component --project integration` | complete admitted W0 + W1 subset; no old shell chain |
| `npm run check:native` | native Node imports every explicitly converted backend file, then runs the checkout bin route |
| `node tools/type-mutations.mjs` | disposable type-error and bare-interface-import failures, then restored positive controls |
| `npm run test:collaboration` | focused integration selector only; not complete acceptance |
| `test:dashboard:browser`, `test:pi:dashboard`, `test:release` | exit 2 with honest W4/W5 or W3/W7 prerequisites, never invokes legacy live commands |
| `test:management:real` | existing explicit GOLEM_REAL_HARNESS opt-in; never invoked by check/test/CI |

- **Unit:** catalog and compact-ticket behavior migrated directly; Knip debt-key behavior. Setup forbids processes/network. No child wrappers in unit.
- **Component:** jsdom project exists, **zero suites pending W4**; explicit startup notice. No coverage claimed or placeholder test.
- **Integration:** model-providers (in-memory Vite assets), CLI verb help (direct Vitest conversion from node:test), safety/private-scratch tests, and each assertion script below as its own bounded case.
- The three original node:test files now use direct Vitest registrations. Pure suite paths moved to `test/unit/`; all original behavior is retained.
- TypeScript strict converted-file includes currently contain `cli/bootstrap.ts`. Explicit .ts native paths, erasable syntax, verbatim imports, allowJs without checkJs. Native smoke reads that list so a future conversion cannot silently miss smoke coverage.
- Biome includes the converted file and owned tooling/test scaffolding/direct migrations. Legacy assertion programs are not wholesale reformatted/linted. Adding new converted/owned areas expands the positive include policy; no broad rule suppression.
- Later CI gates remain pending: W3 contracts freshness/diff, W4 token literal checks, W3 installed-tarball emission, W7 render artefacts. Local checkout checks do not accept shipped artefacts.

## Adapter inventory and retirement

Source of runner truth: `test/support/adapter-inventory.json`, **50 distinct cases**: 39 retained W0 test scripts, nine dashboard scripts, W1 profile-isolation, one additional MCP test outside W0's original 67-file census. Upstream `39a80536` removed worker-ancestor, worker-claude-control and worker-control tests; only their three adapter/Knip entries were retired. Every other admitted adapter remains. W0's historical census is retained; its other four eligible suites are direct Vitest registrations.

Each case captures complete stdout/stderr/exit/signal/timeout. Latest receipts persist under gitignored `.test-results/<path>.json`, even when Vitest's reporter suppresses successful console logs. A failing script is a failing case, not a skip. A selector run may skip cases; only the unfiltered command counts as full acceptance.

| Source adapter | Timeout ms | Fixed port preflight |
| --- | ---: | --- |
| `test/agent-cli.test.mjs` | 90000 | ephemeral / none |
| `test/claude-cli.test.mjs` | 90000 | ephemeral / none |
| `test/dashboard-model-profiles.test.mjs` | 90000 | 7634 |
| `test/dispatch-brief.test.mjs` | 90000 | ephemeral / none |
| `test/gol369-integration.mjs` | 90000 | ephemeral / none |
| `test/herdr-driver.test.mjs` | 90000 | ephemeral / none |
| `test/html-block-service.test.mjs` | 90000 | ephemeral / none |
| `test/instruction-block.test.mjs` | 90000 | ephemeral / none |
| `test/intake-suggestion.test.mjs` | 90000 | ephemeral / none |
| `test/management-consumers.test.mjs` | 90000 | ephemeral / none |
| `test/management-lock-race.test.mjs` | 90000 | ephemeral / none |
| `test/management-process.test.mjs` | 90000 | ephemeral / none |
| `test/management-registry.test.mjs` | 90000 | ephemeral / none |
| `test/management-resolve.test.mjs` | 90000 | ephemeral / none |
| `test/md-body.test.mjs` | 90000 | ephemeral / none |
| `test/mermaid-check.test.mjs` | 90000 | ephemeral / none |
| `test/notification-cli.test.mjs` | 90000 | ephemeral / none |
| `test/notification-delivery.test.mjs` | 90000 | ephemeral / none |
| `test/notification-schedule.test.mjs` | 90000 | ephemeral / none |
| `test/pi-cli.test.mjs` | 90000 | ephemeral / none |
| `test/pi-delivery-failures.test.mjs` | 90000 | ephemeral / none |
| `test/pi-tracker-integration.test.mjs` | 90000 | ephemeral / none |
| `test/real-actor-setup.test.mjs` | 90000 | ephemeral / none |
| `test/real-resource-allocation.test.mjs` | 90000 | ephemeral / none |
| `test/role-preset.test.mjs` | 90000 | ephemeral / none |
| `test/runtime-compatibility.test.mjs` | 90000 | ephemeral / none |
| `test/scrub-legacy-harnesses.test.mjs` | 90000 | ephemeral / none |
| `test/session-cli.test.mjs` | 90000 | ephemeral / none |
| `test/session-facts.test.mjs` | 90000 | ephemeral / none |
| `test/session-project-pinning.test.mjs` | 90000 | ephemeral / none |
| `test/session-start-role.test.mjs` | 90000 | ephemeral / none |
| `test/spec-sharing-recovery.test.mjs` | 90000 | ephemeral / none |
| `test/spec-sharing.test.mjs` | 90000 | ephemeral / none |
| `test/state-watcher.test.mjs` | 90000 | ephemeral / none |
| `test/team-registry.test.mjs` | 90000 | ephemeral / none |
| `test/team-retained-pane.test.mjs` | 90000 | ephemeral / none |
| `test/ticket-cli.test.mjs` | 90000 | ephemeral / none |
| `test/typed-immediate-retry.test.mjs` | 90000 | ephemeral / none |
| `test/typed-worker-endpoint.test.mjs` | 90000 | ephemeral / none |
| `dashboard/scripts/api-smoke.mjs` | 90000 | 7611 |
| `dashboard/scripts/dispatch-smoke.mjs` | 90000 | 7612 |
| `dashboard/scripts/queue-when-idle-smoke.mjs` | 90000 | 7612 |
| `dashboard/scripts/smoke-gol-197.mjs` | 90000 | ephemeral / none |
| `dashboard/scripts/smoke-gol-256.mjs` | 90000 | ephemeral / none |
| `dashboard/scripts/smoke-gol-318.mjs` | 90000 | ephemeral / none |
| `dashboard/scripts/smoke-gol-422-drainer.mjs` | 90000 | ephemeral / none |
| `dashboard/scripts/smoke-gol4-agent-peek.mjs` | 90000 | 7842 |
| `dashboard/scripts/tracker-smoke.mjs` | 90000 | ephemeral / none |
| `test/profile-isolation.test.mjs` | 120000 | ephemeral / none |
| `mcp/channel/tracker-client.test.mjs` | 90000 | ephemeral / none |

Scaffolding retires per touched suite: split its assertions into direct Vitest cases sharing explicit fixtures, retain its affected native consumer check, then remove that adapter entry and obsolete executable. No giant wrapper/&& chain remains. W5 replaces boundary fakes with versioned scrubbed simulator scenarios rather than pretending these adapter cases are golden-fixture acceptance.

## Isolation and cleanup

- Before any native test import: allowlisted env, unique temporary HOME, GOLEM_HOME, XDG roots, assets/DB, projects/ideas/skills, private URLs, no inherited agent/Claude/Pi/herdr identities or credential/config selectors.
- Suite-specific HOME/GOLEM_HOME remain authoritative for Claude config/tombstones. Do not pin those to a different inherited root. No caller NODE_OPTIONS survives; only the owned runtime guard is installed.
- PATH contains owned fake/deny binaries plus OS utility dirs and a Node symlink. Native executable resolution canonicalizes symlinks and permits only fixture paths inside the exact sandbox. A missing fake redirects to an owned nonexistent absolute path, preserving Node ENOENT with no ambient search fallback.
- Native inventory fakes return empty Claude/herdr inventories; all other default native/credential-helper invocations fail closed. Suites may supply owned fakes. No real harness or credential reads.
- Guard rejects default ports 7420/7421 and non-loopback requests before connecting. Fixed ports are preflighted; readiness checks cannot substitute an already-running service.
- Private IPC allocation grant prevents test entry until existing project process-group/birth probes capture the true main incarnation. Descendant grant flags are cleared; existing fixture IPC stays separate. Each child owns a process group. Main signals require immediate pre-signal current birth/group matching; guard-observed residual members preserve ownership after leader exit. Stale/indeterminate evidence retains roots without signaling. Deadline races process EXIT, not pipe CLOSE; fenced detached subgroup teardown happens before bounded pipe drain. Captured PID/birth records fence subgroup signals. Always-written receipts retain nonzero/timeout/drain/cleanup failures. Unix /tmp sandbox roots are siblings, so worker afterAll cannot erase an uncertain retained child root. Darwin EPERM is never treated as absence without a successful OS group-table proof.
- Three main-ownership controls prove stale/unavailable probe refusal, retained exact owned recovery, and genuine residual cleanup after leader exit. Seven adapter-safety cases include actual detached inherited stdout/stderr on timeout and parent exit. An eighth uncertain-token case proves bounded drain/root retention and restores only its saved true owned incarnation to reap the negative fixture. Both HTTP/private-DB scratch override negatives enforce quarantine; a mismatched DB path/handle is rejected.
- W1's profile test starts private dashboards/Vite/MCPs, proves disjoint profiles/native imports, and cleans aliases/listeners. No dist/watch build is required for backend TypeScript.

### Candidate repairs, not runtime changes

- W1 already removed sync instruction-size lint. No audit-skills/instruction-workflow/actual-content parity enters this gate; synthetic marker transport and card application remain.
- api/dispatch smoke creates via `_scratch`, records IDs, archives in finally before reaping children/DB removal; api restores XDG-backed self-registration rather than inheriting GOLEM_HOME.
- api-smoke now tests current task/spec kinds instead of retired fix kind, and the CC-only command-cell producer (`substrate.js:globalCells`) rather than expecting a removed second harness.
- dispatch-smoke asserts queued admission `ok:true`, `accepted:false`, and failed `delivery.ok:false` separately (`notification-service.js` + receipt producer); it never labels admission as work success.
- Imported upstream agent-cli assertions preserve scoped native selection through owned fixture DTOs. Removed worker-process authority tests are not revived; scoped-stop's real native journey remains unrun, not replaced by a fake pass.
- Drainer uses the approved explicit private-DB `_scratch` entry: exact owned path must match the live handle, enforced quarantine fields after caller fields, finally archive and drainer.close before tracker.close/removal.
- tracker-smoke is a wholly private DB **behavior fixture**, not control-plane smoke tickets. Default-human creator and cascade semantics require explicit synthetic fixture entities; no real project namespace/live DB read.
- queue wrapper has bounded execution; Gol4 child is reaped before endpoint/state removal. Detached process evidence and cleanup errors are preserved.
- html-block-service's sanitizer mutant lives only in an owned complete module/dependency mirror (html-body, body-anchor, parse5, entities), never dashboard/server in the checkout. Unique mirror roots and exclusive mutant writes resist collisions. Actual timeout/SIGTERM/collision negatives preserve production source and reclaim the owned mirror; the ordinary service path is unchanged.
- typed-immediate-retry's long multi-restart fixture renews its exact live canonical/owner/host/port lease every 5s only while its row exists. TTL stays 45s. Released gaps remain absent; synchronous heartbeat invocation and request/renewal counters assert no renewal/request in the gap. Timer stops before teardown. No production clock/scheduler/TTL change.

## Explicit excluded/opt-in suites and fixture work

| Source | Why excluded now / needed replacement |
| --- | --- |
| dashboard-lifecycle | touches shared7420 and restart/sweep; rebuild owned-process lifecycle fixture |
| model-profiles, worker-journey, team-journey, session-native | real native facilities; W5 herdr/argv/lifecycle simulator scenarios |
| management-real-journey | explicit real-harness acceptance/recording candidates only, operator facilities/authorization |
| scoped-stop | REAL-NATIVE / NOT RUN: upstream source starts actual Herdr sessions/panes and sleep processes. Preserved byte-for-byte; excluded from default/Vitest/CI. Human opt-in-only manual acceptance requires explicit authority; no new public npm script added. |
| cross-harness-matrix, pi-journey, pi-tools-journey | installed Pi/pi-tui dependency; simulator-backed native-loader boundary or retain pinned opt-in reason |
| gol346-acceptance | copies live Pi auth/models; replace with synthetic offline scenario |
| management-dashboard | Chrome journey; W4/W5 private Playwright/axe lane |
| release-smoke | network installation + native lists; W3 redesign into emitted-tarball acceptance |
| substrate-api | writes checkout substrate; owned synthetic source/profile fixture required |
| instruction-workflow | reads/lints actual instruction text; never part of the engineering gate |

W0's historical 14 exclusions and seven helpers remain recorded, not silently discarded. The imported scoped-stop suite adds one explicit real-native exclusion; it is not a skipped admitted adapter. Other dashboard scripts remain excluded per W0 until rebuilt on owned fixtures/E2E infrastructure.

## Knip schema, raw evidence and debt policy

Pinned Knip **6.39.0**, `knip.json.$schema = ./node_modules/knip/schema.json`. Config retains root/child-package analyses, not npm workspaces. Entries extend W0 with bootstrap/bin/dev/Claude path resolver, Ladle, W1 profile test, direct suites, tooling and adapters. Files under instruction trees are not inspected.

Command `npx knip --reporter json > /tmp/gol458-knip-committable-raw.json` exits **1** because existing debt exists. Captured raw report: `docs/testing/knip-raw-baseline.json`. dependencies=3, devDependencies=4, unlisted=5, unresolved=6, binaries=8, exports=110; **136 findings**.

`tools/knip-baseline.json` stores exact file/category/namespace/name identities, not just counts or ignore globs. The comparison gate rejects new identities and duplicate counts, permits resolved findings, and fails on malformed output/operational failure. Unit mutations prove equal-count replacement and duplicate findings fail the baseline comparison.

Reviewed debt groups:
- 110 unused exports: legacy/helper seams across management, compiler, dashboard and parsing. Keep until a touching slice proves no consumer; dynamic runtime consumers are separately declared as entries. W2 does not bulk-delete them.
- Three unused runtime deps (@dnd-kit/sortable, @dnd-kit/utilities, jsonc-parser) and @babel/parser: W6 scrub entries, not waived forever.
- Testing Library/Playwright deps: intentionally staged unused until W4 authoring/E2E (three exact devDependency findings). They are not component coverage.
- Eight native utility binary findings: installed CLI/runtime/opt-in sources and OS utilities, not npm dependencies. Exact baseline entries, no all-binaries suppression.
- Five unlisted dependency findings: root SDK/esbuild consumers, generated MCP child, Pi-provided pi-tui; W3/W7 artefact/dependency ownership resolves these, not root placeholder packages.
- Six Pi helper-relative imports are render-time copy paths; W7 emitted-helper integration resolves them. No unresolved-import category is disabled.

## Linux parity and remaining acceptance

Node **22.22.3**, Debian bookworm CI/devcontainer; Linux needs git, python3/make/g++ (native SQLite), procps (process birth), **jq** (actual SessionStart hook), and an explicit **init/reaping parent**. Devcontainer sets `init:true`; both Actions job containers set `options: --init`. Docker CI-parity image has dependency provisioning network access, then supported runtime uses `docker run --rm --init --network none`: no HOME/credentials/socket mounts, published ports, named volumes or shared stacks.

Do not depend on a shell remaining PID1. GOL-472's final-command Node launch without init failed6/16 from orphan-reaping absence; its retained-bash launch passed16. Preserve that failed topology, do not reinterpret it as generic Linux success: `docs/testing/gol472-linux-faults.log.gz`, `docs/testing/w2-linux-init.md`. Main/runtime/test source remains the reviewed2bd7db1 snapshot; this configuration change makes the consumer prerequisite explicit.

Remote Actions run is separate from local Docker Linux evidence. CI checks are not reported as passed merely because macOS is green. E2E/release job staging stays explicitly pending W3/W4/W5/W7.
