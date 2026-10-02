# Exact initial rejected candidate repair

GOL505 found two material defects in initial14f44: busy was invisible except ARIA/paint, and
unbroken Badge text/Input label/error overflowed320px. Those40 PNGs are rejected review input,
not accepted baselines. The prior manifest and images remain immutable in git history.

## Source decisions

Button reserves the same token-sized cue slot in idle and busy, deliberately increasing old idle
width. A static decorative hourglass becomes visible during busy; label/name, paired paint, focus,
geometry across the transition and duplicate suppression are retained. IconButton keeps its32/44
hit target and fixed glyph slot; original glyph remains in DOM and switches visibility with the
static cue. No animation/palette/font/token changes. Disabled wins over busy.

Badge text and Input visible labels/errors wrap unbroken strings; native single-line input values
keep expected internal scrolling. Actual story props contain unbroken examples. Browser tests
check reduced-motion native transitions with visible cue, unequal before/after pixels and equal
bounds/names/focus, plus text ranges/document overflow at320 across all theme/density combinations.

## No general baseline overwrite

Default capture/copy still refuses existing destinations. Only the explicitly rejected tuple is
eligible for the special operation:

- Candidate14f44e418f4297d6e67ff82c506329b723f635d8.
- Original sourcefb13de1e2f66e0e931224c82251d4aa4f25795f6.
- ManifestSHA2563e3917bacf4b044e50fee66141e4d0245209238560e2dd8508a633e9b30100f5.
- Exact kind `initial-atom-baseline-candidates-NOT-ACCEPTED`, exactly40known PNG names+manifest,
  regular owned files and all original hashes/dimensions. Kind alone is never authority.

Accepted/unknown/missing/mismatched sets fail untouched. The code does not accept arbitrary old
commits or hashes. New repair source is committed separately from new screenshot artifacts and
requires fresh exact-image/executable/functional proof before recapture.

## Granted runtime commands only

```bash
node test/integration/atoms-linux-probe.mjs \
  --docker-bin /usr/local/bin/docker \
  --docker-host unix:///Users/laveesingh/.docker/run/docker.sock \
  --source-commit "$FROZEN_REPAIR_SOURCE" \
  --mode capture-rejected-14f44 --output "$OWNED_WORK/recapture"
```

Only in an allocated W2 PRIVATE copy can the exact verified old folder be renamed aside before
new initial capture. Complete old bytes/manifest/identity evidence survives outside the disposable
copy. Host source baseline is not removed by recapture. Failed/partial capture cannot publish.
New provenance has its own repair-source identity and `supersedes` references the exact old tuple;
old provenance is preserved rather than rewritten.

Failure aggregation includes the cleanup existence probe itself: EACCES/EIO while locating a stage
must append to collected primary/journal/rollback causes, never escape raw and discard them. A named
primary plus uncertain rollback-parent and stage-existence control preserves every cause and leaves
unknown stage/original bytes untouched. This minor followup is transaction-only; the two-plane
rendering/provenance boundary below is unchanged.

```bash
node test/integration/atoms-linux-probe.mjs \
  --source-commit "$FROZEN_REPAIR_SOURCE" \
  --mode replace-rejected-14f44 --output "$OWNED_WORK/recapture/candidates" \
  --evidence "$OWNED_WORK/host-replacement-evidence"
```

After validator0 only: reverify old hashes/parent+old inode/device, stage validated new40+manifest
as same-parent sibling, and journal parent/old/stage identities/hashes BEFORE moves. Fence every
rename, rollback and cleanup. Rename old to guarded backup, stage to target; restore old only
from verified backup with absent target. Unknown replacement paths stay untouched. On success,
retain complete old bytes/manifest and journal as evidence; the ORIGINAL old backup inode is also
retained by a fenced rename into evidence/original-backup, never deleted as the last original.
Original evidence-parent/root/old-set identities and original stage/old hash sets are frozen before
callbacks and rechecked after callbacks and before publication/retention/cleanup/completion.
Same-inode content changes are not authorized by identity alone. Unknown paths fail untouched with
original backup/evidence retained; primary, rollback and cleanup-fence failures are aggregated.
No code or PNG changes are mixed: commit new41 candidate artifacts ONLY after successful guarded
replacement. New images remain NOT_ACCEPTED pending untouched delta+visual review, separate normal
no-update comparison/full coherent checks and coordinator rerun. No shell/model/legacy activation.

## Approved transaction-only maintenance bridge

The current40 candidate pixels/visual repair are sound. A nonrender transaction-only fix does NOT
recapture images or rewrite manifest1cd2ce93956b58b660d666a2e68149f109e3e48e9362dfe6fbb5a740c53625ba.
Approved a5261982/50e1b1fd verification uses TWO explicit planes:

1. NEW maintenance commit: exact transaction/helper tests/docs delta, real old-fail/new-pass boundary
   faults, complete guard/unit/integration/unfiltered checks. Helper prefix (all provenance/input/
   render/capture/compare code) and private-retirement section must remain byte-identical to2ab.
2. ORIGINAL frozen rendering candidate2ab9c6fa62f71b5de4d20bef579b49107abfabb4 / render source9c719:
   owned exact copy, same pinned observed image/browser, functional20 and normal40 comparison,
   no update/capture/copy. This old render probe is NOT proof of the new transaction implementation.

A maintenance receipt OUTSIDE baseline directory binds both commit pins, old candidate/render pin,
original manifest hash, exact changed paths and old/new helper hashes plus unchanged section/input
hashes. It is written after the maintenance commit, never embeds a self-referential source hash.
Default new-code comparison still refuses raw old helper-input mismatch; there is no module-wide
ignore or generic exception. Any actual render/input-enumeration/capture/compare change invalidates
this bridge and requires a new explicit proof/candidate flow. Fresh untouched guard review and full
independent two-plane/coordinator acceptance remain mandatory.
