# Static checkpoint evidence

Executed from `.worktrees/GOL-466-w4-design` on 2026-10-01. Updated after GOL-468's
primary Button state-pair concern; supersedes the first checkpoint's counts.

| Command | Exit / observed output |
|---|---|
| `node docs/design/w4/prototype.mjs --write` | 0; wrote isolated exemplars only |
| `node docs/design/w4/prototype.mjs` (re-run) | 0; PASS: 4 combinations; 273 public tokens; 124 contrast pairs; 7 font hashes/licenses; deterministic outputs |
| `node docs/design/w4/static-check.mjs` (re-run) | 0; PASS: 23 negative mutations; 24 primary state/theme/density checks; repeat-build equality; committed-output equality; selectors; no primitive CSS; 7 WOFF2 hashes/licenses |
| `cmp design-lab/index.html ../../design-lab/index.html` | 0; identical copied HTML |
| `cmp design-lab/README.md ../../design-lab/README.md` | 0; identical copied README |
| `git diff --check` | 0; no whitespace diagnostics |

Separate retrieval probe checked both downloaded npm tarballs against registry `dist.integrity`
using SHA-512: `geist npm tarball integrity PASS`; `mono npm tarball integrity PASS`.
Pinned retrieval URLs and integrity strings are retained in `provenance.json`; no font package
was installed. Hashes, byte counts and WOFF2 signatures verify files, not glyph rendering.

Minimum pair arithmetic (full exact pair list is `generated/contrast.json`):

| Theme / threshold | Lowest ratio | Pair |
|---|---|---|
| Light / 4.5 body | 4.669854 | accent.ink / accent.fill |
| Light / 3 UI | 3.120188 | focus.color / surface.selected |
| Dark / 4.5 body | 4.542038 | text.muted / surface.selected |
| Dark / 3 UI | 3.635563 | focus.color / surface.selected |

Ratios are rounded for reporting only; generation compares full precision. Dark muted and
light focus have limited margin: opacity, overlays or a different surface void the checked pair.

Primary Button state-pair calculations (six state pairs × two themes, all ≥4.5):

| Theme | default / hover / active / focus / busy | disabled |
|---|---|---|
| Dark | 6.978008 each | 6.629908 |
| Light | 4.669854 each | 6.933115 |

Enabled states retain the accent fill/ink pair. Disabled switches both paints to disabled surface/text;
no opacity or silent WCAG exemption. Generic hover/active backgrounds are explicitly forbidden for
primary paint. Static checks cover six states × two themes × two densities (24 combinations).

Negative artifact probes: the original ten (unresolved alias, cycle, alias type mismatch,
component→primitive shortcut, semantic literal, negative dimension, unsupported type, invalid name,
translucent color, equal-color contrast), plus three declaration-coverage corruptions (missing hover,
duplicate default, weakened disabled threshold), six state paint corruptions, and four reproductions
of generic hover/active background mixed with primary ink (both themes). All 23 reject as expected.
These are isolated static probes, **not** W2 runner or production-tool tests.

`git diff --check 5598ad5` passes; corrective diff only touches `docs/design/w4/`. Palette source,
font/provenance files and both committed lab copies are unchanged from the first checkpoint.

Not run: live dashboard, user Chrome, new browser prototype, Ladle, component tests, axe,
screenshots, production token-lint, real legacy-island page journey, full repository suites.
Dispatch explicitly defers those consumers until W2 and forbids live/global paths. The unchanged
copied lab was not visually re-reviewed; no new interactive visual prototype was authored.

Remaining owners: fresh reviewer/independent verifier for these static assets; coordinator for
integration slot; W4 builder after W2 for production generator/lint, asset port and UI acceptance.
No merge, global sync, package edits or live restart is part of this checkpoint.
