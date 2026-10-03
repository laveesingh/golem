# W2 main-group incarnation fence — GOL-467

Accepted remaining major03c2fe53: the main child was retained only by numeric PID/PGID and signaled after EXIT/deadline without a pre-signal incarnation fence. Post-signal absence proof could not protect a recycled group.

## Allocation and authority

- The adapter allocates a detached Node child with private IPC and a random grant.
- Runtime guard sends its ready PID/grant before source entry and clears the grant flag from inherited env. Parent uses existing captureProcessGroup/processBirth contracts while the main process remains blocked, stores the true snapshot, then grants entry.
- No grant means no source entry. Capture errors/timeouts remain bounded and retained; private IPC closure is not OS signal authority.
- Runtime guard records actual spawned PID/birth/PGID observations. These extend only the captured group's owned members, so a genuinely owned residual member can keep group authority after its leader exits.
- Main cleanup uses existing processGroupProcesses/processGroupMatches/processBirth, validating current group/incarnation synchronously immediately BEFORE SIGKILL. Unknown/stale/indeterminate evidence never authorizes a signal. Empty group is distinguished from an owned incarnation moving elsewhere. EPERM requires successful current absence proof, never an assumption.
- No production management module was changed. Knip drops one real unused export finding because processGroupProcesses now has this consumer; baseline136 remains unchanged and exact added-debt detection stays active.

## Actual deterministic controls

main-ownership.test.mjs:
1. Stale controlled birth probe on a live owned main: zero pre-signal callbacks, retained root/timeout receipt, unchanged actual captured incarnation, recovery only with the true allocation snapshot.
2. Unavailable controlled probe: same refused-signal/retention/exact recovery contract.
3. Actual owned same-group residual child: main leader exits, captured live child incarnation still authorizes cleanup; all original/residual members and root absent afterward.

No actual PID reuse, unrelated-process signal, production clock/TTL/scheduler mutation or real harness was attempted. Prior inherited-pipe/uncertain-root/mirror/quarantine negatives remain in the same focused run.

Targeted command:
```bash
npx vitest run --project integration test/integration/main-ownership.test.mjs test/integration/adapter-safety.test.mjs test/integration/retained-root.test.mjs test/integration/html-mutation-safety.test.mjs test/integration/scratch-fixture.test.mjs
```
Observed exit0,5files/16tests (/tmp/gol458-main-fence-targeted.log).
npm run check:exit0,37Biome files/strict/native0; Knip baseline136/current135/added[], resolved processGroupProcesses export (/tmp/gol458-main-check-targeted.log).

## Final changed-artefact evidence

- macOS check:exit0,37Biome files/strict/native0; unchanged baseline136/current135/added[], explicitly resolved processGroupProcesses export (/tmp/gol458-main-check-final.log).
- macOS full unfiltered projects:exit0,11files/93tests,no skips,210.14s (/tmp/gol458-main-macos-full.log).
- Rebuilt network-disabled Linux:check0 with same37files/136→135/no added; full unfiltered11files/93tests/no skips,181.36s; native/bin0 and type negatives2/2/1 then restored0/0 (/tmp/gol458-main-linux-build.log,/tmp/gol458-main-linux-full.log).
- macOS native/bin and type controls likewise0 (/tmp/gol458-main-native.log,/tmp/gol458-main-types.log).
- Actual Linux main-fence receipts:docs/testing/w2-main-fault-receipts.json. Refusal receipts intentionally capture retained live-root state before tests recover using true owned snapshots. Genuine residual case is an actual same-group owned child after leader EXIT.

All53candidate adapters and prior pipe/retention/mirror/quarantine negatives remain included. Prior83/90-test evidence is historical. Remote Actions/amd64, W3/W7 artefacts and W4 component/E2E remain pending. New narrow review and complete independent verification required; no merge/W3 release.
