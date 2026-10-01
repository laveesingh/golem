# W5 Stage B1 — runner integration, not complete W5 acceptance

Verified base: `e3c6d4a3ea041648662272e0c52c6de1c2fd39ee`.

Branch/worktree: `feat/gol-438-simulators`, `.worktrees/GOL-465-simulators`.
B1 source/checkpoint: `dda671a9f3777e9fa4e3b80584a5915cf4ad9598`; later evidence-only commit does not change that tested source.

## Scope and shared ownership

Stage A was rebased onto accepted W2/CI source. Root and channel dependency trees
were copied CoW from verified integration, not installed in the worktree. Only
scenario module/type/formatting fixes, owned unit/integration/probe fixtures, docs,
and the **two exact lane-B supplied config patches** are included:

- Initial SHA256: `5fec762d5da1fc536c11d84e9edf27d5effb8d66ef38e663076067acf177b39b`.
- Follow-up SHA256: `a63e3c9ecf0a0e659872f2e4e61bebfe2a63dea69d8626dc978939e8c0e1d7a4`.
- Both `git apply --check` commands exit 0; actual hashes match the owner receipts.
- Five explicit TS includes join bootstrap in the existing native import list.
- Existing Vitest globs discover new tests; no framework/runner behavior change.
- Biome positive `test/sim/**` scope covers TS/MJS support, **not extensionless
  launcher lint/format coverage**. Launcher native behavior/syntax is exercised.
- Explicit Knip support entry grounds extensionless dynamic imports. Removed own
  truly redundant exports, not debt suppression. One exact OS fixture dependency
  key `test/integration/scenario-probe.mjs|binaries||mkfifo` is owner-approved;
  no blanket binary ignore or baseline regeneration. Future different findings
  still fail. Shared converted paths must be unioned with W3's paths on merge.
- No package/lock/dependency, production clock/recorder/seam/header or global edit.

`mkfifo` is an OS/coreutils test prerequisite, not an npm/native-harness dependency.
It exists at `/usr/bin/mkfifo` on macOS and in the Debian CI image. The integration
probe creates a FIFO only under its owned temp root, asserts the Node scrub CLI
rejects it within a five-second parent deadline, and removes it after reaping
children. This tests O_NONBLOCK/non-regular input rejection, not private input.

## Owned test coverage

Two direct Vitest unit suites (40 tests) cover closed format/source/enums, privacy
sentinels/semantic redaction/no hashes, canonical rejection, symbol continuity,
raw/canonical argv slot failures, contradictory exit metadata, owned IO creation,
symlink/type/mode/size/malformed input, exclusive600 collision, and failed-created
inode cleanup versus changed-replacement preservation. Unit setup forbids all
process/network use; IO uses owned temp files only.

One integration suite has four bounded native probe cases under **existing W2
runScript ownership, environment/guard, main-group fence and receipt cleanup**:

| Case | Observable behavior |
|---|---|
| CLI | Actual native TS scrub/check entry; synthetic label; private600 exclusive candidate; unknown input fails without output; owned FIFO rejected |
| Contracts | Actual Node launchers for Claude/Pi/herdr; literal argv/stdout, exit7, exhaustion; exact wrong-slot/hidden leading flag/missing value/relative path failures before cursor/output |
| Identities | Caller/generated and occupied-suffix collisions; two generated IDs; reopen consistency; retained locks/cursor bytes; numeric canonicalization/port increment; dangling cursor and unbound PID refusal |
| Faults | stdin/stderr; external TERM/INT/HUP after owned lock cleanup; forced SIGKILL leaves residual until parent reaps/owns cleanup; unread stdout deadline exits2; consumed cursor remains an explicit uncertain outcome; recorded signal |

All fixtures are authored synthetic data, never golden recordings. These consumer
checks call local Node prototypes, not installed harnesses/models/network. The
forced SIGKILL probe proves **prototype parent cleanup only**, not real actor or
production seam failure acceptance.

## macOS full candidate commands

```sh
npm run check
node node_modules/vitest/vitest.mjs run --project unit --project component --project integration
npm run check:native
```

All **exit 0** on Node22.22.3. Check: Biome **47 files/0**, strict **0**, Knip
baseline137/current136/**no added**, explicit native imports **6/0**. Unfiltered
Vitest: **14 files, 137 tests passed**, no skips, **214.88s**. Component remains
zero suites pending W4, not component acceptance. Native helper import plus
checkout bin/help both exit0. Focused 40unit/4integration runs were subset-only.

Earlier checks **failed** on owner-patch formatting, extensionless support graph,
mkfifo declaration and redundant exports; corrected by exact owner follow-up and
own source fixes. No failed run is counted as acceptance.

## Supported offline Linux full candidate

Only a committed source archive was copied into a disposable image; no host HOME,
credentials, sockets, source mounts, published ports, named volumes or shared stack.
Existing Dockerfile provisions public dependencies during image build (network
setup); actual verification runtime is **--init --network none**:

```sh
context=$(mktemp -d /tmp/gol465-ci-context.XXXXXX)
trap 'rm -rf "$context"' EXIT
git archive dda671a9f3777e9fa4e3b80584a5915cf4ad9598 | tar -x -C "$context"
docker build -f "$context/.devcontainer/Dockerfile.ci" -t golem-gol465-b1:dda671a "$context"
docker run --rm --init --network none --name "golem-gol465-b1-$(date +%s)" golem-gol465-b1:dda671a
```

Build **exit0**; supported runtime **exit0**. Image
`sha256:245ed892e1aa2e620025cef1705b7377ed887dbbafc3c514189e0242fd62288b`,
Linux arm64/Debian bookworm/Node22.22.3. Full existing CMD executes check, unfiltered
Vitest, native smoke and disposable type controls:

- Biome47/strict/Knip/native import **exit0** (baseline137/current136/no added).
- **14 files/137 tests passed**, no skips, **185.92s**; all four W5 native consumer
  modes report PASS and children reaped before root removal.
- Six native imports + checkout bin: **exit0**.
- Type controls: injected type error **2**, bare interface tsc **2**, bare native
  import **1**; restored tsc/native **0/0**, control wrapper **exit0**.
- Owned build context removed by EXIT trap; runtime container removed by --rm.

Full build/runtime logs: `/tmp/gol465-b1-linux-build.log`,
`/tmp/gol465-b1-linux-full.log`. Logs are supporting receipts; source/commands above
are reproducible. Remote Actions amd64 is configured but unrun, not local arm64 proof.

## Remaining unaccepted scope

B1 needs fresh review, independent verification and an explicit serialized spec
merge slot. No merge is assumed. Overall W5 remains incomplete.

B2 awaits W3 canonical JSONL/header/clock/recorder/seam ownership coordination and
explicit release. Genuine recording provenance/sign-off remains unavailable and
unauthorized; no private journals/transcripts/harness/model access was used. No
real recorder/shared-clock/socket/timer injection, four delivery-path goldens,
under-one-wall-second timeout or per-journey mutation acceptance is claimed.

Preserve Stage A limits: private content equality/distinction lost; payload-sensitive
claims require adequate semantic projection/review; output may fail after cursor
consumption and is not safe automatic replay/exactly-once delivery; same-harness
overlap/multi-record stdin unsupported; unbound PID refused; symbolic generated
port/path does not imply a listener/file; real actor/SIGKILL/native and emitted
installed/rendered artefacts are not accepted by these prototype tests.
