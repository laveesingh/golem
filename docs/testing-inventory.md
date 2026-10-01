# Testing inventory — GOL-438 W0

Baseline: `20a5cf5` (5.26.0), examined 2026-10-01. This is a source census, not a passing test report. No legacy test, browser, native command, live state read, or port 7420 probe was executed. W0 changes only this inventory and `knip.json`.

## Census and interpretation

- `find test -type f | sort`: **67** files = **63 top-level** + **4 recursive fixtures**. Top-level = **60 automated assertion suites** + **3 helpers**. Recursive fixtures = three Markdown documents + one silent worker. The locked brief's 64 was not the recursive count; do not discard three paths to match it.
- `find dashboard/scripts -type f | sort`: **74** files, all top-level.
- Exclusion for census: prune any `node_modules` subtree (none existed in either census root). No fixture extension or hidden-file exclusion.
- `rg -n 'test|dashboard/scripts' package.json` gives literal npm wiring; the tables list transitive npm aliases separately from helper imports. Wired does not mean safe or current.
- Automated = assertions/status determine success, even if a live prerequisite makes the file ineligible. Manual = inspection/operator tool without a reliable pass/fail contract. Fixture = data or reusable helper, not an independent test. Historical = a superseded mechanism confirmed by current source, not simply an old ticket number.
- Layer describes behavior, not filename/framework. Existing standalone assertion programs with filesystem/CLI/HTTP/process behavior belong in distinct bounded **integration adapters**, never wrappers pretending to be unit tests.

## W2 eligible boundary

**46 test suites** and the eligible non-browser dashboard scripts listed below are candidates for migration. Eligibility means their assertions can be run without a real harness, browser, network dependency install, live registry, or shared dashboard **under the W1 pre-import isolation bootstrap**. It is not authorization to run them naked now, and not evidence that their existing assertions pass. All 14 excluded whole-file suites remain tracked. Helpers are not independent suites.

The bootstrap must start each integration adapter in a distinct sandbox: temp HOME, GOLEM_HOME, XDG roots, tracker/assets/tombstone DB, projects/ideas/profile dirs; clear inherited GOLEM/PI/Claude/session/native selectors and config overrides (including NODE_OPTIONS and corpus-copy knobs); retarget dashboard/channel URLs to owned endpoints; prevent actual `claude`, `pi`, `herdr`, `cloudflared`, and external credential helpers with fixture/deny executables. Respect scripts that supply their own fake binaries. A GOLEM_HOME override alone is insufficient. Reserve/check fixed private ports before startup; never connect to a preexisting listener as a substitute. Reclaim only owned processes, sockets, files and nested temp roots after exit, including on timeout/failure.

Source-grounded safety paths:

- `lib/golem-home.js:golemHome`: GOLEM_HOME wins over XDG. api/dispatch scripts setting only XDG inherit an overriding GOLEM_HOME unless cleared.
- `dashboard/server/native-sessions.js:49-50, runClaudeAgentsJson`: snapshots HOME at import and invokes `claude agents --json` during discovery. Server state refresh calls it. Temp DB does not stop live native reads; fake/deny executable and pre-import HOME are required.
- `dashboard/server/config.js`: HOME, default channel :7421, project/ideas/root/assets paths are independent of tracker isolation. Redirect them before imports.
- `lib/session-role.js:readClaudeParentSession`: independently reads HOME/.claude/sessions. Management capability/context imports can reach registry/process evidence; synthetic evidence must not fall back to live native calls.
- `lib/herdr-driver.js:herdrBinary, sessionList`: native list can be global even when a fake session string appears elsewhere. Reject installed native paths for W2.
- `dashboard/scripts/_scratch.mjs`: live :7420 default unless GOLEM_SMOKE_API is private. Archive scratch records in finally where this helper is used. Pure private DB fixture suites do not create control-plane smoke tickets.
- `dashboard/scripts/_chrome.mjs`: managed/reused Chrome is an E2E facility, not W2. Browser scripts are not promoted merely because the REST server is private.

### Exact eligible test list

- `test/agent-cli.test.mjs`
- `test/claude-cli.test.mjs`
- `test/cli-verb-help.test.mjs`
- `test/dashboard-model-profiles.test.mjs`
- `test/dispatch-brief.test.mjs`
- `test/gol369-integration.mjs`
- `test/herdr-driver.test.mjs`
- `test/html-block-service.test.mjs`
- `test/instruction-block.test.mjs`
- `test/intake-suggestion.test.mjs`
- `test/management-consumers.test.mjs`
- `test/management-lock-race.test.mjs`
- `test/management-process.test.mjs`
- `test/management-registry.test.mjs`
- `test/management-resolve.test.mjs`
- `test/md-body.test.mjs`
- `test/mermaid-check.test.mjs`
- `test/model-catalog.test.mjs`
- `test/model-providers.test.mjs`
- `test/notification-cli.test.mjs`
- `test/notification-delivery.test.mjs`
- `test/notification-schedule.test.mjs`
- `test/pi-cli.test.mjs`
- `test/pi-delivery-failures.test.mjs`
- `test/pi-tracker-integration.test.mjs`
- `test/real-actor-setup.test.mjs`
- `test/real-resource-allocation.test.mjs`
- `test/role-preset.test.mjs`
- `test/runtime-compatibility.test.mjs`
- `test/scrub-legacy-harnesses.test.mjs`
- `test/session-cli.test.mjs`
- `test/session-facts.test.mjs`
- `test/session-project-pinning.test.mjs`
- `test/session-start-role.test.mjs`
- `test/spec-sharing-recovery.test.mjs`
- `test/spec-sharing.test.mjs`
- `test/state-watcher.test.mjs`
- `test/team-registry.test.mjs`
- `test/team-retained-pane.test.mjs`
- `test/ticket-cli.test.mjs`
- `test/ticket-compact.test.mjs`
- `test/typed-immediate-retry.test.mjs`
- `test/typed-worker-endpoint.test.mjs`
- `test/worker-ancestor.test.mjs`
- `test/worker-claude-control.test.mjs`
- `test/worker-control.test.mjs`

### Safe unchanged versus bootstrap candidates

Only `model-catalog.test.mjs`, `ticket-compact.test.mjs`, and `model-providers.test.mjs` avoid mutable state/native facilities in the exercised paths unchanged (the last builds assets in memory). `state-watcher.test.mjs` tests a pure function, but its static import loads config.assetsDir, which resolves golemHome immediately; it is a bootstrap candidate, not a naked-run exemption. All other eligible rows require the pre-import conditions above plus the row-specific resource controls. Isolated child-process execution is an integration adapter, not a unit wrapper.

### Test files (complete recursive census)

| Path | Class | Existing npm wiring | Layer | Resource needs | W2 | Reason / evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `test/_interactive-attach.py` | fixture | `unwired; imported/invoked helper` | integration helper | Owned PTY + actual app | helper only | Real journey helper; arbitrary argv executed under PTY; only management-real-journey invokes it. |
| `test/_management-list.mjs` | fixture | `unwired; imported/invoked helper` | unit helper | None | helper only | Shared schema-v2 parser imported by CLI/native suites; not independent assertions. |
| `test/_real-actor-setup.mjs` | fixture | `unwired; imported/invoked helper` | integration helper | Explicit metadata facilities | helper only | Real-journey prerequisite/resource planner; tests use synthetic temp facilities. Not an executable suite. |
| `test/agent-cli.test.mjs` | automated | `unwired` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp GOLEM_HOME before imports; fake GOLEM_HERDR_BIN and injected manager/native DTOs; real owned Node groups. Integration, not process-wrapped unit. |
| `test/claude-cli.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp state and PATH fake Claude/Ollama executables capture argv/exit/signal. CLI integration. |
| `test/cli-verb-help.test.mjs` | automated | `unwired` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | node:test registrations invoke CLI with temp HOME/GOLEM_HOME, assert zero writes. Integration despite node:test syntax. |
| `test/cross-harness-matrix.test.mjs` | automated | `test:collaboration`, `test (via test:collaboration)` | integration | See explicit hazard | excluded | Installed Pi located through which pi and linked pi-tui; real MCP children plus extension stand-in. Not harness-free even though state/HTTP are temp. |
| `test/dashboard-lifecycle.test.mjs` | automated | `test` | integration | Private dashboard + Chrome | excluded | Actual shared isHealthy(7420) calls at L175 and L223. Restarts/sweeps processes; explicit exclusion, not merely a literal origin. |
| `test/dashboard-model-profiles.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Private tracker/state and fake Pi catalog; fixed 7634; inherited HOME/native discovery needs outer isolation and native deny stubs. |
| `test/dispatch-brief.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp registered project and brief template; asserts payload pointers, not skill prose. In-process filesystem integration. |
| `test/fixtures/md-blocks/nested-details.md` | fixture | `unwired; imported/invoked helper` | integration data | None | helper only | Markdown parser fixture consumed by md-body tests; includes nested details, rich blocks or no trailing newline. |
| `test/fixtures/md-blocks/no-trailing-newline.md` | fixture | `unwired; imported/invoked helper` | integration data | None | helper only | Markdown parser fixture consumed by md-body tests; includes nested details, rich blocks or no trailing newline. |
| `test/fixtures/md-blocks/rich.md` | fixture | `unwired; imported/invoked helper` | integration data | None | helper only | Markdown parser fixture consumed by md-body tests; includes nested details, rich blocks or no trailing newline. |
| `test/fixtures/mermaid-silent-worker.mjs` | fixture | `unwired; imported/invoked helper` | integration helper | Worker thread | helper only | Hung-worker fixture used by mermaid timeout test; never launch as normal suite. |
| `test/gol346-acceptance.test.mjs` | automated | `unwired` | integration | See explicit hazard | excluded | Conditional installed Pi launch at L174 onward; reads/copies caller HOME/.pi/agent auth/models at L189. No whole-file W2 eligibility. |
| `test/gol369-integration.mjs` | automated | `unwired` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Private dashboard on ephemeral port; sanitized actor hints; scratch helper retargeted to private API. CLI/REST integration. |
| `test/herdr-driver.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp fake GOLEM_HERDR_BIN, fixture DTO/error/timeouts; no real Herdr. Adapter integration. |
| `test/html-block-service.test.mjs` | automated | `unwired` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp SQLite/ephemeral dashboard plus temporary mutant beside source (finally removed). Serialize or source-mirror its mutation leg. |
| `test/instruction-block.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Synthetic RULES/PREFIX/markers exercise compiler block ownership; not assertions on authored instructions. Temp output/state. |
| `test/instruction-workflow.test.mjs` | automated | `test` | integration | See explicit hazard | excluded | Excluded by parent instruction-inspection policy: lintSubstrate reads real instruction/role/skill files for word counts; test compares actual source/template byte parity. Retain transport checks only after redesign; no W0 fix. |
| `test/intake-suggestion.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp GOLEM_HOME and injected tracker/context; no live API. |
| `test/management-consumers.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Private HTTP/registries, injected native evidence, real owned Node children. Native DTOs are fixtures, not native calls. |
| `test/management-dashboard.test.mjs` | automated | `test`, `test:dashboard:browser` | E2E | Private dashboard + Chrome | excluded | Real headless Chrome, esbuild and private dashboard; E2E/browser layer, not the no-browser W2 subset. |
| `test/management-lock-race.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Explicit temp lock paths and owned Node PID birth/race barriers. OS process integration. |
| `test/management-process.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Capture/terminate only a detached owned Node process group; real OS signals, no Herdr. |
| `test/management-real-journey.test.mjs` | automated | `test:management:real` | integration | Native/installed facility or source tree (see reason) | excluded | Opt-in actual Pi/Claude and Herdr; requires explicitly provisioned private facilities and authorization. Never run for this inventory. |
| `test/management-registry.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp migrations/registries and fake native seams; owned lock contender; mutation mirrors inside temp. |
| `test/management-resolve.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Fake native binary/ps and private HTTP; actual CLI schema-v2 consumer; temp state. Disable inherited caller/native env. |
| `test/md-body.test.mjs` | automated | `unwired` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp SQLite and ephemeral dashboard. Optional GOLEM_TRACKER_DB_COPY must be unset in W2; corpus mode is separately authorized. |
| `test/mermaid-check.test.mjs` | automated | `unwired` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp SQLite and real worker threads; silent-worker fixture proves timeout. No dashboard/native harness. |
| `test/model-catalog.test.mjs` | automated | `test` | unit | None (in-memory values) | safe unchanged | Direct pure catalog parser/TTL functions; no executable catalog read invoked. |
| `test/model-profiles.test.mjs` | automated | `test` | integration | Native/installed facility or source tree (see reason) | excluded | Real private Herdr with fake Pi/Claude children. Native dependency, not the no-real-harness W2 subset. |
| `test/model-providers.test.mjs` | automated | `test` | unit + build integration | Read-only assets + memory Vite build | safe unchanged | Direct provider matching plus Vite build(write:false)/VM asset adapter. No browser, server or dist writes. |
| `test/notification-cli.test.mjs` | automated | `test:collaboration`, `test (via test:collaboration)` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp tracker/private dashboard; fake context/process tree and private receiver; sanitize inherited env and native scans. |
| `test/notification-delivery.test.mjs` | automated | `test:collaboration`, `test (via test:collaboration)` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp SQLite plus injected publisher/drainer/native session DTOs. No real dashboard/harness. |
| `test/notification-schedule.test.mjs` | automated | `test:collaboration`, `test (via test:collaboration)` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp SQLite transactions/contenders plus injected clocks/publisher; integration storage behavior. |
| `test/pi-cli.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp HOME/profile and fake Pi executable; isolated render lifecycle; no actual Pi. |
| `test/pi-delivery-failures.test.mjs` | automated | `test:collaboration`, `test (via test:collaboration)` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Private SQLite locks and callback HTTP server; in-process adapter seams, no Pi executable. |
| `test/pi-journey.test.mjs` | automated | `test` | integration | Native/installed facility or source tree (see reason) | excluded | Installed Pi/pi-tui resolution and real Pi RPC/provider journey at L794; registered-root/worktree sensitivity. Separate compatibility lane. |
| `test/pi-tools-journey.test.mjs` | automated | `test` | integration | Native/installed facility or source tree (see reason) | excluded | Installed Pi/pi-tui path resolution; real extension loaded onto harness stand-in. Separate installed-path lane, not portable W2. |
| `test/pi-tracker-integration.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Explicit temp DB, two connections; real pickup/ack transaction integration. |
| `test/real-actor-setup.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Metadata-only facilities and --import guard; child exits setup-only before runtime allocation. No credentials/native app. |
| `test/real-resource-allocation.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp metadata facilities; inject allocation failures and verify inode cleanup fencing; no native app. |
| `test/release-smoke.mjs` | automated | `test:release` | artefact | See explicit hazard | excluded | npm pack/install accesses dependency network; unstubbed session list can invoke native Herdr. Pending W3 redesigned artefact acceptance (installed tarball/package roots/renders); preserved, not discarded. Never included in W2. |
| `test/role-preset.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp state/roles and fake Pi argv; source card filenames are plumbing, no instruction wording assertion. |
| `test/runtime-compatibility.test.mjs` | automated | `test:collaboration`, `test (via test:collaboration)` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp registry/private HTTP; injected provider/version DTOs and mutation mirror. No real harness. |
| `test/scrub-legacy-harnesses.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | CLI scrub operates on temp HOME registry/DB/render fixture paths; no live stores. Outer sandbox must reclaim temp not cleaned by script. |
| `test/session-cli.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp GOLEM_HOME and injected native inventory/control DTOs, no server. CLI integration. |
| `test/session-facts.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp GOLEM_HOME, but readNativeSessions invokes Claude CLI and HOME registry. Eligible only with pre-import temp HOME and deny/fake Claude. |
| `test/session-native.test.mjs` | automated | `test` | integration | Native/installed facility or source tree (see reason) | excluded | Real private Herdr server/socket and CLI controls; no app launch, but still native. Separate authorized integration. |
| `test/session-project-pinning.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp HOME before native module import; synthetic .claude sessions. readNativeSessions still invokes Claude CLI: deny/fake Claude required. |
| `test/session-start-role.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp HOME/cards and shell hook; synthetic card-marker selection checks injection plumbing only. Requires bash/jq. |
| `test/spec-sharing-recovery.test.mjs` | automated | `unwired` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp registry/real hanging HTTP fixtures and injected process/spawn probes. ORIGIN :7420 is inert command/config data, never fetch target. |
| `test/spec-sharing.test.mjs` | automated | `unwired` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp tunnel state, injected cloudflared/process probes and private REST dashboard. ORIGIN :7420 only inert fixture identity; no tunnel/public network. |
| `test/state-watcher.test.mjs` | automated | `test` | unit | Pre-import HOME/GOLEM_HOME (eager config.assetsDir resolution) | candidate: bootstrap | Direct stableWatchedPaths pure function; does not call createState/init or discover native sessions. Outer HOME/GOLEM_HOME before static imports: config.assetsDir calls golemHome during module load. |
| `test/substrate-api.test.mjs` | automated | `test` | integration | See explicit hazard | excluded | Creates/deletes substrate/skills in checkout at L97; no source mirror and no failure cleanup of that source skill. Must isolate source before automation. |
| `test/team-journey.test.mjs` | automated | `test` | integration | Native/installed facility or source tree (see reason) | excluded | Real private Herdr plus fake Pi; stop/delete before removing socket roots. Separate native lane. |
| `test/team-registry.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Temp GOLEM_HOME; in-process membership/name/context fixtures; no native runtime. |
| `test/team-retained-pane.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Owned runtime/shell Node groups, fake Herdr binary and injected controls. Real stop signals only owned PIDs. |
| `test/ticket-cli.test.mjs` | automated | `unwired` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Private dashboard/DB and injected caller; real grandchild CLI simulates context, no native app. |
| `test/ticket-compact.test.mjs` | automated | `test` | unit | None (in-memory values) | safe unchanged | Direct shapers and tool runtime with fake client/callbacks. Pure unit. |
| `test/typed-immediate-retry.test.mjs` | automated | `test:collaboration`, `test:pi:dashboard`, `test (via test:collaboration)` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Private tracker/dashboard, real typed HTTP endpoints, injected application callbacks. No native Pi. |
| `test/typed-worker-endpoint.test.mjs` | automated | `test:collaboration`, `test (via test:collaboration)` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Private SQLite/typed HTTP server and drainer seams; no real harness. Outer HOME before static imports and tombstone path guards. |
| `test/worker-ancestor.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Owned Node ancestor/app replacement tree; injected native/process evidence; only owned group killed. |
| `test/worker-claude-control.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Owned Node process and synthetic Claude UUID DTO binding; not actual Claude. |
| `test/worker-control.test.mjs` | automated | `test` | integration | Private FS/DB/HTTP or owned processes; isolation bootstrap | candidate: bootstrap | Owned Node group plus injected native/app DTOs; fail-closed control evidence integration. |
| `test/worker-journey.test.mjs` | automated | `test` | integration | Native/installed facility or source tree (see reason) | excluded | Real private Herdr; installed Pi SDK lookup; fake app fixture. Native/installed-path suite, not W2. |

### Exact eligible dashboard script list

- `dashboard/scripts/api-smoke.mjs`
- `dashboard/scripts/dispatch-smoke.mjs`
- `dashboard/scripts/queue-when-idle-smoke.mjs`
- `dashboard/scripts/smoke-gol-197.mjs`
- `dashboard/scripts/smoke-gol-256.mjs`
- `dashboard/scripts/smoke-gol-318.mjs`
- `dashboard/scripts/smoke-gol-422-drainer.mjs`
- `dashboard/scripts/smoke-gol4-agent-peek.mjs`
- `dashboard/scripts/tracker-smoke.mjs`

### Dashboard scripts (complete census)

| Path | Class | Existing npm wiring | Layer | Resource needs | W2 | Reason / evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `dashboard/scripts/_chrome.mjs` | fixture | unwired; imported by browser probes | E2E helper | Private/reused Chrome profile + CDP | helper only | Reusable acquireChrome; resolves caller HOME/profile and manages/reuses Chrome. Needs E2E facility isolation; not a test entry. |
| `dashboard/scripts/_probe-drag3.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/_scratch.mjs` | fixture | unwired; imported by REST/browser suites | integration helper | Tracker API; live default 7420 | helper only | Helper defaults to live API; caller must explicitly set private GOLEM_SMOKE_API and archive in finally. |
| `dashboard/scripts/api-smoke.mjs` | automated | unwired | integration | Private server/DB; fixed 7611 | candidate: bootstrap | XDG and tracker overridden but inherited GOLEM_HOME wins; needs outer env clearing, pre-import HOME/native deny and port ownership. Uses actual REST+WS assertions. |
| `dashboard/scripts/check.sh` | automated | `check:dashboard` | integration probe | Existing API; default live 7420 | excluded | Does not provision its own server; defaults to PORT=7420, checks native-sessions route. Only private management-dashboard invokes it with explicit PORT; no standalone W2 path. |
| `dashboard/scripts/comment-image-paste.browser.mjs` | automated | `test:dashboard:browser` | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/debug-page.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/dispatch-smoke.mjs` | automated | unwired; invoked by queue-when-idle-smoke | integration | Private server/DB; fixed 7612 | candidate: bootstrap | XDG-only state redirect can lose to inherited GOLEM_HOME; sanitize env/HOME/native selectors; fake push targets are offline/private. |
| `dashboard/scripts/gol-129-pi-browser.mjs` | automated | `test:dashboard:browser`, `test:pi:dashboard` | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/gol-461-browser.mjs` | automated | `test:dashboard:browser` | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/gol-485-browser.mjs` | automated | unwired | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/gol-495-browser.mjs` | automated | `test:dashboard:browser` | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/gol345-html-browser.mjs` | automated | unwired | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/gol353-offline-routing.browser.mjs` | automated | unwired | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/gol383-comment-dispatch.browser.mjs` | automated | `test:dashboard:browser` | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/import-trackers.mjs` | manual | unwired | migration | Registry + tracker files (live default) | excluded | Operator legacy tracker.md import command, not a test; default writes real DB. No migration executed. |
| `dashboard/scripts/jsx-check.mjs` | historical | unwired | build syntax | External @babel/standalone lookup | excluded | Claims browser Babel presets; current dashboard/web/index.html:28 loads Vite module entry instead. Babel standalone is not installed dependency; external /tmp lookup. Retain as historical candidate for W6, not W2. |
| `dashboard/scripts/nested-composer-overlay.browser.mjs` | automated | `test:dashboard:browser` | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/queue-when-idle-smoke.mjs` | automated | unwired | integration | dispatch-smoke child; fixed 7612 | candidate: bootstrap | Delegates to dispatch-smoke and requires its actual output assertion line. Include separate adapter or documented coverage alias, not missing silently. |
| `dashboard/scripts/screenshot-home.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-alt-click-comment.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-block-comment-decoration.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-classes.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-cleanup.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-composer.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-exhaustive.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-gol-197.mjs` | automated | unwired | integration + source probe | Private server/roots; ephemeral port | candidate: bootstrap | No scratch tickets: private role CRUD API assertions and UI source-string checks. Outer HOME/native deny still needed. Source checks are implementation-coupled debt, not instruction inspection. |
| `dashboard/scripts/smoke-gol-244.mjs` | automated | unwired | integration probe | Existing live dashboard/tickets | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-gol-256.mjs` | automated | unwired | integration | Temp source mirror/HOME/renders | candidate: bootstrap | Synthetic alpha/beta instructions test managed transport/tamper markers; no assertions on authored role/instruction prose. No finally/temp cleanup currently; adapter must reclaim nested temp artifacts. |
| `dashboard/scripts/smoke-gol-318.mjs` | automated | unwired | integration | Temp git repo/worktree | candidate: bootstrap | Temp-only git identity behavior; assumes git init default branch main. Runner must set sandbox git defaults and clear inherited GIT_* overrides; subprocess calls need bound. |
| `dashboard/scripts/smoke-gol-422-badge.mjs` | automated | unwired | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/smoke-gol-422-drainer.mjs` | automated | unwired | integration | Temp SQLite + injected publisher | candidate: bootstrap | Injected state/listChannels/push; real drainer restart assertions. Five 5.3s waits need distinct bounded integration budget; abort cleanup must close timers. |
| `dashboard/scripts/smoke-gol-425-communication.mjs` | automated | unwired | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/smoke-gol-470-board-sort.mjs` | automated | unwired | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/smoke-gol281-polish.browser.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-gol287-section-anchors.browser.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-gol4-agent-peek.mjs` | automated | unwired | integration | Private typed endpoint/dashboard; fixed 7842 | candidate: bootstrap | Private state/DB plus typed endpoint stand-in (no real app). Outer HOME/native deny and fixed-port ownership required. |
| `dashboard/scripts/smoke-grouping.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-model-profiles.mjs` | automated | unwired | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/smoke-nested-comment-anchors.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-overflow.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-overflow2.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-overflow3.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-reply.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-reply2.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-reply3.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-settings.mjs` | automated | unwired | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/smoke-tkt-0194.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0198.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0204.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0206.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0208.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0233.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0234.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0237.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0244.mjs` | automated | unwired | integration probe | Existing live dashboard/tickets | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0245.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0266.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0284.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0285.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0286.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0339.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0369.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0518.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0519.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0648.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tkt-0649.mjs` | automated | unwired | integration probe | Existing live dashboard/tickets | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-toc.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-tracker-ui.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke-where.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/smoke3.mjs` | manual | unwired | UI diagnostic | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/spec-sharing.browser.mjs` | automated | unwired | E2E | Existing live dashboard/tickets + Chrome | excluded | Hardcoded/default live :7420 or existing dashboard-page selection; no self-provisioned full isolation. Live record/UI mutations possible; must rebuild private fixture before automation. |
| `dashboard/scripts/substrate-split-browser.mjs` | automated | unwired | E2E | Private dashboard/DB + Chrome | excluded | Self-provisions dashboard fixtures but needs Chrome via _chrome/direct CDP; browser lane, not W2. Inherited HOME/state/native selectors and reused browser profile still require E2E audit. |
| `dashboard/scripts/tracker-smoke.mjs` | automated | unwired | integration | Temp SQLite DB | candidate: bootstrap | Explicit private DB with SQL assertions/cleanup; outer HOME/config before imported runtime and reclaim all private artifacts. |

## Dashboard scratch and cleanup obligations

The nine script candidates are **migration candidates**, not safe unchanged scripts. In particular, a private DB does not prove the existing smoke convention is honored. W0 reports these defects without fixing or executing them.

| Eligible script | _scratch quarantine / archive in finally | Setup and cleanup obligation before admission |
| --- | --- | --- |
| api-smoke | No helper; direct REST tickets under synthetic PID, no finally archive | Retarget helper to owned API and use quarantine/SMOKE creator/title for smoke records. Close/reap child before DB/XDG removal; reserve 7611. Delete inherited GOLEM_HOME so private XDG self-registration assertion remains meaningful; temp HOME and deny native discovery. |
| dispatch-smoke | No helper; direct REST tickets, no finally archive | Same quarantine/finally repair as api-smoke; reserve 7612; remove inherited GOLEM_HOME to preserve XDG fixture contract. queue-when-idle wrapper inherits all these obligations. |
| queue-when-idle-smoke | Child uses direct creation; no independent helper | Bound child execution and preserve its assertion/output contract; do not count a wrapper as new coverage. Apply dispatch-smoke quarantine/setup obligations. |
| smoke-gol-197 | No scratch tickets; role CRUD only | No ticket helper required. Own HOME/config/native discovery; restore/clean only sandbox role changes, reap child before temp roots disappear. Source-string UI assertions are coupling debt, not behavior proof. |
| smoke-gol-256 | No scratch tickets; compiler synthetic instructions | No helper required. No finally today: reclaim its temp mirror/HOME/render tree at adapter boundary even on failure. Its sync calls still invoke instruction-size lint; synthetic marker assertions may stay, but the new gate must not inspect actual copied instructions/roles/skills via lint. |
| smoke-gol-318 | No scratch tickets; temp git repo/worktree | No helper required. Set git init default to main in owned config, clear GIT_DIR/GIT_WORK_TREE/hooks overrides, bound commands; worktree removal on success, temp tree removal on catch. |
| smoke-gol-422-drainer | Quarantine project + SMOKE title + smoke creator, but directly calls tracker.createTicket, no helper/archive | Helper convention is not honored as written. Needs an agreed private fixture adapter or helper-based smoke rewrite; never run against live DB. Close drainer in finally as well as tracker; current final block only closes tracker/removes dir if assertion aborts mid-drainer. |
| smoke-gol4-agent-peek | No scratch tickets; private session/worker DTOs | No helper required. Isolate pre-import HOME plus fake native scans and fixed 7842; shut down owned typed endpoint/dashboard before deleting state. |
| tracker-smoke | Direct DB tickets under test PID/human creator; only one in-test archive assertion, no finally archive | Core private DB fixtures test identity/default creator semantics; not helper-conformant smoke creation. Preserve those assertions in a bounded integration fixture adapter and document the private-fixture boundary, or obtain convention clarification; do not infer a live-state exception. Finally closes DB and removes DB/WAL/SHM. |

The helper defaults itself are not validation: `createScratchTicket(fields)` spreads fields after quarantine defaults, so callers can override project/creator. A helper import plus a finally token alone is not proof. Every remaining browser/live script is excluded regardless of helper use. The live smoke-tkt family includes direct API/DB/registry mutation and real dispatch targets (for example smoke-tkt-0245/0286/0369 channels registries, smoke-tkt-0648/0649 real dispatch); do not run it to discover isolation.

### Instruction inspection boundary

Per orchestrator clarification, `instruction-workflow.test.mjs` is excluded from the new gate even though its checks are mostly transport/parity: its lint call reads actual instruction files for size, and actual-content parity is also excluded. `scripts/audit-skills.mjs` (outside the 141-file census) enforces frontmatter, description words and references; `npm run check` currently invokes it. Exclude this gate path; W0 did not run/fix it.

`instruction-block` and `session-start-role` test generated markers and synthetic cards. `role-preset` inventories source card filenames, not authored body contents. `pi-cli` and smoke-gol-256 are candidates, not unchanged-safe: the CLI sync path invokes `lintSubstrate` at cli/golem.js:491, which needs removal/bypass of actual instruction inspection before gate admission. Rendering/injection itself is a transport mechanism; do not turn it into content assertions. These are precise candidate obligations beyond environment bootstrap, not completed fixes.

## Existing wiring, reconciled

Root package scripts wire **50 of 67 test files** and **7 of 74 dashboard scripts** by literal path. Unwired totals are **17 tests** (including seven helpers/data) and **67 scripts** (including two helpers and one historical checker). The test:collaboration eight paths are also transitively wired from test. Seven dashboard literal paths comprise six browser scripts and check.sh. The browser aliases also reference management-dashboard in test/. No assumption that the && chain reaches later suites.

An additional wired test outside the requested census, `mcp/channel/tracker-client.test.mjs`, was read: automated integration over real private MCP children/dashboard/SQLite and synthetic native registry entries, no actual harness needed. It is an **additional W2 isolation candidate**, not a member of the 67 or 46. Clear GOLEM_CHANNEL_SOURCE and native/actor/base URL overrides; fake/deny native discovery; pre-import parent HOME; guarantee child reap before deleting temp paths. Baseline source has stale fixed-port header (actual port is ephemeral), plus mutation files in channel source and many child cleanup paths. Keep it in the wiring reconciliation and independent review.

## Knip entry ownership

`knip.json` declares the root and mcp/channel workspaces; entries are explicit existing paths, not catch-all runtime module exemptions. Test entry membership is independent of runner eligibility: knip statically follows excluded programs too and never executes them. It does not inspect instruction Markdown.

| Entries | Source evidence |
| --- | --- |
| cli/golem.js | Root package.json bin and exports; CLI verbs statically import their command modules. |
| dashboard/server/index.js | Root dashboard/dashboard:serve scripts; lib/dashboard-process.js dynamically spawns the server path. |
| dashboard/web/src/entry.jsx; dashboard/vite.config.js | dashboard/web/index.html:28 module script; root dashboard build/dev npm commands. Sequential explicit dynamic imports in entry.jsx connect the global component modules. No old Babel script entry is inferred. |
| mcp/channel/index.js | substrate/mcp.json argv contains CLAUDE_PLUGIN_ROOT/mcp/channel/index.js; channel package main/start. Separate workspace owns SDK dependency resolution. |
| shims/pi/golem.ts | lib/compiler/adapters/pi.js buildPlan extension item and emitted Pi package extensions array. The source imports ./lib helpers that exist only in a render; see known false positives below. |
| lib/session-facts-write.js | substrate/hooks/session-register.sh:263-267 resolves FACT_WRITER dynamically and invokes node. |
| dashboard/server/mermaid-worker.mjs | dashboard/server/mermaid-check.js:29,62 constructs worker path and new Worker; explicit entry retains this dynamic edge. |
| test/fixtures/mermaid-silent-worker.mjs | mermaid-check test supplies worker override for deliberate hung-worker timeout. It is an entry for static dependency accounting, not an independent test suite. |
| lib helpers explicitly listed in root entry | Runtime source arrays in lib/compiler/adapters/cc.js:290-295 and pi.js:36-40 copy these modules to renders. String-based copy is not an import. The seventeen-file union is intentionally bounded; do not broaden to lib/** entries. |
| All 60 assertion suites in test/ plus channel tracker-client.test | Current standalone executable entrypoints; excluded runner paths still have static dependencies. Helpers are followed through imports, not blanket fixture/test exports exemption. |
| All 71 executable dashboard .mjs entries (excluding _chrome/_scratch); three root scripts | Operator/automation entrypoints, including unwired/live/historical programs. Tables expose wiring debt separately: declaration does not claim a runtime consumer or justify retention. _chrome/_scratch are imported helpers, check.sh is shell outside Knip JS project. |

Project files include all JS/TS/JSX/MJS source. Only dependency directories, ticket worktrees, generated plugin/, dist/ and dashboard/dist/, and the separately owned channel workspace are removed from the root project set. These are source/artefact ownership exclusions, not issue suppressions. No ignoreDependencies/ignoreExports/ignoreIssues was added; no dependency was installed.

### Baseline debt and false-positive candidates

**Not measured findings:** knip is absent from copied dependencies (`test -x node_modules/.bin/knip` exits 1). W2 must install its chosen version and run `./node_modules/.bin/knip --config knip.json --reporter compact`, capturing raw findings/exit code before deciding which are true debt. Config schema/runtime validation is pending that dependency; JSON syntax and entry existence alone do not prove Knip accepts every field.

- Source Pi shim relative imports `./lib/*.js` point to rendered-layout helpers, not files under shims/pi/lib in checkout. Explicit render-helper entries keep their source graph, but unresolved relative imports can still need a bounded resolver/build mapping in W2/W7. Do not suppress all unresolved imports.
- Pi's pi-tui is provided by the installed harness, not a declared root package dependency. Root import failure is a source-layout/facility candidate, not evidence of a dead shim. Real installed-Pi suites remain excluded from W2.
- mcp/channel imports zod in tracker-client.test while package.json declares only MCP SDK; hoisted/transitive availability is not direct declaration. Classify measured dependency findings without broad ignore.
- mcp/channel package check refers to nonexistent scripts/smoke.js. Do not invent that entry or execute the broken check.
- Retained standalone manual scripts may reveal genuine dependency debt; declaring them as entry only makes their dependency closure visible. No future script glob was used to hide new unreferenced modules.
- Generated plugin/ duplicates source/render ownership and is excluded deliberately. Source runtime modules and newly added files under source project globs still enter dead-file analysis.
- Actual unused files/exports/dependencies are not asserted here because knip has not run. No deletion proposed from filename age alone.

## Reproduction and W0 evidence

Run only static census/config validation here; no application module is imported by the commands below.

```bash
find test -type d -name node_modules -prune -o -type f -print | sort
find test -maxdepth 1 -type f | wc -l
find test -type d -name node_modules -prune -o -type f -print | wc -l
find dashboard/scripts -type d -name node_modules -prune -o -type f -print | sort
find dashboard/scripts -type d -name node_modules -prune -o -type f -print | wc -l
rg -n 'test|dashboard/scripts' package.json
git diff --check
test -x node_modules/.bin/knip
```

Observed: census roots **67/74**, test top-level **63**; npm wiring **50/17** test wired/unwired and **7/67** dashboard wired/unwired. Census/search commands exit 0. Knip availability exits **1** (absent); no install/npx/network attempt. git diff --check exits **0**.

The static reconciliation below checks duplicate-free path equality, 46/14/7 test membership, 9 script candidates, literal npm wiring and explicit entry existence. Observed exit **0**, output:
```text
test: rows=67; npm-wired=50; unwired=17
dashboard/scripts: rows=74; npm-wired=7; unwired=67
PASS: 141 unique census rows; 60 automated + 7 fixtures; 46 eligible + 14 excluded; 9 script candidates; all explicit knip entries exist
knip entries: root=158; channel=2
```

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const walk = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => e.name === 'node_modules' ? [] : e.isDirectory() ? walk(dir+'/'+e.name) : [dir+'/'+e.name]).sort();
const expected=[...walk('test'),...walk('dashboard/scripts')].sort();
const doc=fs.readFileSync('docs/testing-inventory.md','utf8');
const rows=doc.split('\n').filter(l=>/^\| `(?:test|dashboard\/scripts)\//.test(l)).map(l=>l.split('`')[1]).sort();
assert.equal(rows.length,new Set(rows).size);
assert.deepEqual(rows,expected);
const testRows=doc.split('\n').filter(l=>/^\| `test\//.test(l));
assert.equal(testRows.filter(l=>l.includes('| automated |')).length,60);
assert.equal(testRows.filter(l=>l.includes('| fixture |')).length,7);
assert.equal(testRows.filter(l=>l.includes('| excluded |')).length,14);
assert.equal(testRows.filter(l=>l.includes('| candidate: bootstrap |')||l.includes('| safe unchanged |')).length,46);
assert.equal(doc.split('\n').filter(l=>/^\| `dashboard\/scripts\//.test(l)&&l.includes('| candidate: bootstrap |')).length,9);
const config=JSON.parse(fs.readFileSync('knip.json','utf8'));
for(const [base,w] of Object.entries(config.workspaces)){
  assert.equal(w.entry.length,new Set(w.entry).size);
  for(const entry of w.entry) assert.ok(fs.statSync(base+'/'+entry).isFile());
}
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
for(const root of ['test','dashboard/scripts']){
  const paths=walk(root),wired=paths.filter(p=>Object.values(pkg.scripts).some(s=>s.includes(p)));
  for(const p of paths){
    const row=doc.split('\n').find(l=>l.split('`')[1]===p&&l.startsWith('| '));
    for(const [name,cmd] of Object.entries(pkg.scripts)) if(cmd.includes(p)) assert.ok(row.includes('`'+name+'`'));
  }
  console.log(root+': rows='+paths.length+'; npm-wired='+wired.length+'; unwired='+(paths.length-wired.length));
}
console.log('PASS: 141 unique census rows; 60 automated + 7 fixtures; 46 eligible + 14 excluded; 9 script candidates; all explicit knip entries exist');
console.log('knip entries: root='+config.workspaces['.'].entry.length+'; channel='+config.workspaces['mcp/channel'].entry.length);
NODE
```

Worktree setup (each succeeded, exit 0):
```bash
git worktree add .worktrees/GOL-456-inventory -b docs/gol-438-inventory spec/gol-438-foundations
cp -Rc node_modules .worktrees/GOL-456-inventory/node_modules
cp -Rc mcp/channel/node_modules .worktrees/GOL-456-inventory/mcp/channel/node_modules
```

Limitations: source-grounded eligibility is not a behavior pass. No legacy suite, Chrome, Herdr, installed Pi, actual tracker fixture or live dashboard was executed. Knip's parser/schema/runtime baseline is pending W2 installation; W0 provides only JSON/entry/census validation. Independent reviewer/verifier must check the whole-file safety and classification claims before closure. No global render/version/runtime change; no merge without the orchestrator's slot.