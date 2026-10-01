# W5 Stage A evidence — not complete W5 acceptance

Base: `b0ab5796efb5494af15152b9b1293986f241a643`

Branch/worktree: `feat/gol-438-simulators`, `.worktrees/GOL-465-simulators`

Only new `tools/scenario-*`, `test/sim/` and `docs/testing/` sources are included.
No package/lock/runner/config/W2 fixture or production clock/seam file changes.
Both dependency trees were copied from main with `cp -Rc`, not installed.

## Commands actually run

From the ticket worktree:

```sh
for file in tools/scenario-format.ts tools/scenario-scrub-core.ts tools/scenario-io.ts tools/scenario-scrub.ts test/sim/support.ts test/sim/claude test/sim/pi test/sim/herdr; do node --check "$file" || exit; done
node /tmp/gol465-stage-a-smoke.mjs
```

Syntax command: **exit 0**, no output. The scratch smoke script is an owned
synthetic-only temporary program, not a landed runner test. It imports the pure
modules, invokes only these Node CLI prototypes (plus `mkfifo` for an owned
non-regular-input rejection case), creates 0700/0600 scratch resources and reaps
owned children before removing its private root. Child environments contain only
PATH, temporary HOME/TMPDIR and explicit scenario/state variables. It does not
call Golem/harness executables, any model, network, or production seam.

Final smoke command: **exit 0**, actual output:

```text
format/scrub: exact schema+sequence, bounded structural allowlist, stable typed symbols, semantic redactions/no secret bytes, unknown/malformed/mixed input exit2, exclusive600 candidate and non-golden label PASS
failure cleanup: external TERM during inherited-open stdin retains signal after cleanup; unread stdout exits2 within2s; dangling unknown cursor symlink preserved PASS
sim prototypes: all three exact argv/stdout/exit paths, symbol continuity, mismatch/exhaustion exit2, stdin+stderr, own SIGTERM after lock cleanup, collision preserved, no fallback/network/model/clock integration PASS
owned scratch inputs/cursors/candidates removed PASS
```

Observed negative cases include unknown schema/scenario/version/field, inherited
Object-prototype field names, wrong direction/sequence/time, PID0, raw/symbol
mixture, already-existing output, FIFO input, unknown argv, symbol retargeting,
exhausted scenario, absent stdin, cursor/lock collision and dangling cursor link.
Preflight/argv-rejected requests do not advance/create cursors; post-consumption
IO failure is uncertain, as disclosed below. Recorded nonzero exit7 and
recorded SIGTERM are preserved; external TERM during blocked stdin cleans its
owned lock before termination. Backpressured stdout fails by its real IO deadline
and dedicated CLI exit does not await an unread pipe forever.

One intermediate **failed** scratch fault probe exposed the unread-output case:
`simulator: stdio write deadline exceeded` appeared, but the child did not exit
until the parent safety-killed it (`null !== 2`). The dedicated CLI was corrected
to exit only **after** resource cleanup, even with a pending pipe drain; the final
probe above then passed. This is prototype IO cleanup, not a production/W2 edit.

`git diff --check` — **exit 0**. New-file staged/committed diff checks and exact
commit are reported on GOL-465 after checkpoint creation.

## Reproducible small demonstration

This is a demonstration, not a runner/recording/integration test:

```sh
root=$(mktemp -d /tmp/w5-demo.XXXXXX)
chmod 700 "$root"
mkdir "$root/state"
chmod 700 "$root/state"
trap 'rm -rf "$root"' EXIT
sample="$PWD/docs/testing/examples/synthetic-processes.json"
node tools/scenario-scrub.ts --check "$sample"
GOLEM_SIM_SCENARIO="$sample" GOLEM_SIM_STATE_DIR="$root/state" node test/sim/herdr --version
```

Expected `herdr synthetic`, not a native version/recording. No recordings or
native binaries are required. The source sample's synthetic label is mandatory.

## Unrun gates and remaining evidence

- W2 accepted integration and explicit Stage B release; no spec merge slot yet.
- Strict/native/Vitest/Linux gates and landed unit/integration failure tests wait
  W2. These eight native syntax checks and scratch assertions are not those gates.
- Recorder implementation, shared clock/socket and actual endpoint/Pi/drainer
  timing injection are design only; no under-one-wall-second timeout claim.
- Genuine authorized source recordings, pinned run provenance, scrub review and
  reviewer sign-off for all four golden scenarios: none available/authorized now.
- Four actual delivery-path replays and one behavioral mutation per journey,
  actor/pipe/SIGKILL/socket teardown failure evidence, W3 canonical contracts and
  journal/spool-header coordination, emitted helper distribution and fresh
  review/independent verification remain Stage B.
- Same-harness overlapping processes and multi-record stdin need the Stage B
  broker model, not the independent untimed prototype cursors. Unbound PID
  output is refused. Generated port/path consequences are not listeners/files.
- Cursor consumption before output means failed IO after consumption is uncertain;
  no safe replay/exactly-once/native delivery guarantee is asserted.

No raw private journals/transcripts, real harness/model/browser, credentials,
ports7420/7421, live restart, global sync, main merge or version changes occurred.
