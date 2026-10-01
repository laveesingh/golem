# W2 accepted review fixes — GOL-464

Original frozen checkpoint:36784c41cac21f3632382238c48bc622167dd879.
Review975f844b identified two majors and one minor. This delta keeps all53adapters/all46eligible W0 suites, strict/native/Knip semantics and explicit pending component/artefact scope.

## Process deadline and inherited pipes

Old adapter awaited CLOSE before subgroup cleanup. Detached descendants inheriting stdout/stderr could keep CLOSE pending after main-group kill.

New adapter races EXIT with the timeout, tears down main and incarnation-fenced detached groups independently, then bounds pipe draining. Every outcome writes a receipt including timeout/drain/cleanup fields. Uncertain group identity does not authorize a signal or root deletion. Unix sandbox roots are independent /tmp siblings, preventing worker afterAll from erasing retained child roots.

Real negatives: timeout-pipe-group and exit-pipe-group spawn actual detached Node descendants with inherited stdout/stderr, record their PID/birth, and prove bounded returned failure plus complete owned cleanup. uncertain-pipe-group corrupts only its fixture birth record; the adapter returns a bounded drain/cleanup failure and retains roots. The test restores its saved original owned token, performs fenced cleanup and removes only that exact root. No broad PID/filename cleanup.

Darwin can report EPERM for a just-reaped empty group; absence requires a successful OS process-table proof. Errors or a present group remain fail-closed. Streams are never treated as the process lifecycle boundary.

## Source mutation mirror

Old html-block-service wrote fixed dashboard/server/.gol343-mutant.mjs and relied on child finally. SIGKILL could leave it in the checkout.

New helper copies only the required graph into a unique owned root: html-body.js, body-anchor.js, parse5 and entities (including parse5 nested dependencies), with explicit ESM package scope. Mutant creation is exclusive (wx). Its ordinary and unsafe-mutant outputs preserve the original two-guard sanitizer negative.

Negatives prove two independent mirrors, rejected overwrite collision without byte changes, actual SIGTERM interruption, and actual timeout. The adapter reclaims mirrors even when child cleanup cannot run. Every control checks production source bytes unchanged and no checkout mutation path. The ordinary html-block-service adapter is included in full verification.

## Quarantine enforcement

Both HTTP and private-DB _scratch helpers put project_id, created_by and SMOKE title after caller fields. The actual private HTTP request negative tries forbidden real-project/human creator fields, verifies quarantined payload and finally archive; the private-DB negative retains handle/path ownership checks.

## Targeted evidence

Command:
```bash
npx vitest run --project integration test/integration/adapter-safety.test.mjs test/integration/retained-root.test.mjs test/integration/html-mutation-safety.test.mjs test/integration/scratch-fixture.test.mjs
```
Result:exit0,4files/13tests (/tmp/gol458-delta-negatives-second.log).
npm run check:exit0,35Biome files/strict tsc0/Knip136→136/no added/native0 (/tmp/gol458-delta-check-first.log).

First negative run deliberately exposed Darwin's just-reaped EPERM and an unsettled top-level-await timeout fixture exiting13 without an event-loop hold. Corrections use OS absence proof and a real held event loop; changed controls then pass. One exact retained root from that failed control was removed only after verified group absence.

## Final complete evidence

- macOS npm run check:exit0,Biome35files/strict tsc/Knip136→136/native0 (/tmp/gol458-delta-check-final.log).
- macOS full unfiltered projects:exit0,10files/90tests,no skips,200.97s (/tmp/gol458-delta-macos-full.log). Ordinary html-block-service mutation consumer and all53candidate adapters included.
- Rebuilt Linux image runtime --network none:exit0; check35files/strict/Knip136→136/native0; unfiltered10files/90tests/no skips,176.82s; native/bin0; type mutations expected2/2/1 then restored0/0 (/tmp/gol458-delta-linux-build.log,/tmp/gol458-delta-linux-full.log).
- macOS native/type controls likewise0 with expected2/2/1 then restored0/0 (/tmp/gol458-delta-native.log,/tmp/gol458-delta-types.log).
- Actual Linux fault receipts extracted verbatim from the full run:docs/testing/w2-review-fault-receipts.json. They include actual inherited-pipe timeout/parent-exit, unknown-token bounded drain/root retention, and mirrored mutation timeout/SIGTERM. Tests recover only their saved true owned token after the uncertainty control; retained-root receipt intentionally records the pre-recovery failure state.

The initial83-test evidence in w2-evidence.md is historical, superseded by this90-test review delta. Remote Actions/amd64 remains UNRUN; W3/W7 shipped artefacts and W4 component/E2E remain pending. No production scheduler/TTL/clock, main/global/version/live or W3 change. Fresh delta review and complete independent verification are still required.
