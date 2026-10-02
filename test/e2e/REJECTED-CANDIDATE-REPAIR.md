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
retain complete old bytes/manifest and journal as evidence before removing verified siblings.
No code or PNG changes are mixed: commit new41 candidate artifacts ONLY after successful guarded
replacement. New images remain NOT_ACCEPTED pending untouched delta+visual review, separate normal
no-update comparison/full coherent checks and coordinator rerun. No shell/model/legacy activation.
