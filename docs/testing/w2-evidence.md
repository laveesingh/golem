# W2 source-gate evidence — 2026-10-01

Base: spec/gol-438-foundations b0ab5796efb5494af15152b9b1293986f241a643.
Ticket branch: feat/gol-438-ts-runner-ci. This is builder self-check evidence; fresh review/independent verification still follow.

## Final checks (unchanged runtime source after these runs)

| Platform / command | Actual outcome | Saved evidence |
| --- | --- | --- |
| macOS Node22.22.3: npm run check | exit0; Biome32files0, strict tsc0, Knip baseline136/current136/added[]/resolved[]0, native import0 | /tmp/gol458-check-final.log |
| macOS: npx vitest run --project unit --project component --project integration | exit0; 8files/83tests passed, no skips;195.33s | /tmp/gol458-all-final.log |
| macOS: npm run check:native | exit0; native bootstrap import and checkout bin help | /tmp/gol458-native-final.log |
| macOS: node tools/type-mutations.mjs | overall0; expected TS2322 exit2, TS1484 exit2, native interface-export SyntaxError exit1; restored tsc/native0/0 | /tmp/gol458-types-mutation.log |
| Linux clean Node22.22.3-bookworm image: npm run check | exit0; same32files and136→136 exact Knip debt | /tmp/gol458-linux-run-final.log |
| Linux: full Vitest projects | exit0; 8files/83tests passed, no skips;171.27s | /tmp/gol458-linux-run-final.log |
| Linux: native smoke + type mutations | exit0; native bootstrap/bin; same expected2/2/1, restored0/0 | /tmp/gol458-linux-run-final.log |
| Static W0 coverage/receipt reconciliation | all46eligible suites accounted; all53adapter receipts exit0, no timeout, every sandbox root absent | .test-results/*.json (gitignored), GOL-458 closing evidence |
| git diff --check | exit0 | ticket comment / commit check |

Component is **explicitly empty pending W4**. Eight files/83 tests are unit/integration, not component coverage. W0's14excluded suites/sevenhelpers remain tracked. This is not live harness acceptance.

The Linux image provisions dependencies with network access; runtime has **--network none**, no mounts/published ports/named volumes/credential facilities. Debian jq/ps/git/native-addon prerequisites are declared identically in Docker/Actions. The Docker evidence is Linux arm64; remote Actions ubuntu24.04/amd64 is configured but **UNRUN**, not substituted by the local platform.

## Repeatable Linux command

Run from the ticket checkout. Source includes generated plugin files to retain the same136-finding Knip graph; excludes dependencies, git metadata and generated dist/test outputs. The disposable image creates synthetic git metadata only inside itself.

```bash
CTX=$(mktemp -d /tmp/gol458-linux-build.XXXXXX)
tar --exclude='node_modules' --exclude='./.git' --exclude='./dashboard/dist' --exclude='./.test-results' -cf - . | (cd "$CTX" && tar -xf -)
docker build -t golem-gol458-ci:local -f "$CTX/.devcontainer/Dockerfile.ci" "$CTX"
rm -rf "$CTX"
docker run --rm --init --network none --name golem-gol458-ci-$(date +%s) golem-gol458-ci:local
docker image rm golem-gol458-ci:local
```

Actual final build exits0: /tmp/gol458-linux-build-final.log. Actual final runtime exits0: /tmp/gol458-linux-run-final.log. Runtime CMD is npm run check, unfiltered projects, native smoke, type mutations. No installed Golem state is mounted.

The results above are historical multi-command launches with a retained shell. Arbitrary container entrypoints without an init/reaping parent are NOT certified: GOL-472's final-command Node/PID1 launch failed6/16. Supported Linux verification now requires explicit `--init` (devcontainer `init:true`, Actions `container.options: --init`); see `w2-linux-init.md` and the preserved `gol472-linux-faults.log.gz`.

## Failure-to-pass contracts

- First integration:62pass/8fail, exit1 (/tmp/gol458-integration-first.log). Sanitized environment overrides initially prevented suite-specific Claude/tombstone roots; corrected inherited roots, preserving own HOME/GOLEM_HOME.
- agent-cli failed available-control assertion because its fake own-actor DTO omitted current application evidence. Source-grounded in worker-control.js; added synthetic owned current PID/program, not runtime fencing changes. Changed targeted source then passes in full final runs.
- api-smoke tested retired fix kind/two-harness command cells; current tracker kinds are task/spec/doc, substrate.js globalCells only emitsCC. Corrected test fixture/filter and exact single CC cell expectation; no production API changes.
- dispatch-smoke conflated admitted notification queue with successful delivery. Current notification-service.js receipt producer separates ok:true queued admission, accepted:false and delivery.ok:false. Assertions preserve both meanings.
- Runtime guard initially broke execFile's custom promisify return and macOS /var→/private canonical paths. Preserved custom promisify and canonicalized containment; no host fallback.
- Missing-fake guard initially threw before expected Node ENOENT; changed resolution to owned nonexistent absolute path. Absent-fake negative proves ENOENT path is inside sandbox/missing-native, not ambient PATH.
- Linux first run check0/layers80pass1fail, exit1: actual SessionStart hook needs jq. Added jq to all parity definitions, no hook skip.
- macOS prior full80pass1fail, exit1: multi-restart fixture exceeded45s lease lifetime. Exact live endpoint heartbeat renews only one existing canonical/owner/host/port row; deliberately released row remains absent with synchronous heartbeat and request/renewal assertions. Timer clears before teardown; production TTL/clock/scheduler unchanged.
- Full final macOS and rebuilt network-disabled Linux runs after these changes:83pass0fail/no skips.
- Knip exact-key baseline mutations reject equal-count replacement and duplicate findings; malformed JSON/operational failures remain fatal. Raw Knip exits1 for reviewed136 findings; comparison gate exits0 only with no added debt.

## Gaps and owners

- Remote GitHub Actions has not run: ticket branch is not pushed. Local Docker Linux is actual evidence, not remote CI status.
- W3 owns emitted tarball/installed-node_modules acceptance. No W2 tarball pass claimed; Node cannot strip bootstrap.ts under node_modules.
- W7 owns full emitted-render artefact acceptance. W1 profile test exercises existing private render consumers; this does not accept W7's new emission pipeline.
- W4 owns component suites/token literals/Ladle/axe/screenshots; W5 owns golden-scenario simulators. E2E/release scripts explicitly report pending prerequisites with nonzero exit instead of success placeholders.
- Nine audit findings remain baseline debt; docs/testing/dependency-audit.md names package/severity/direct/transitive/runtime exposure. No harmlessness or remediation claim.
- Independent review and verification are required before spec integration. No main merge/version bump/global sync/live dashboard restart.
