# First five atoms (GOL-501)

These atoms are an isolated W4 authoring slice. They are not mounted in the legacy dashboard.
The source uses accepted semantic/component tokens and local licensed fonts. No palette, shell,
router, store, theme migration, or remote-font removal is part of this task.

## Public API and decisions

| Atom | Contract |
| --- | --- |
| Button | Nonempty `label`; `primary` default, optional `quiet`; `type="button"` default, explicit submit/reset supported. Explicit id/name/describedBy/onClick/disabled/busy props only. No native/style rest spread. |
| IconButton | Same action contract; `quiet` default, optional primary; nonempty accessible `label`. `icon` must be a decorative inline SVG root made from svg/path/circle/rect/line/polyline/polygon/g/defs/use shapes. Interactive, focusable, custom-component, foreignObject, and inline-style glyphs are rejected. The wrapper is aria-hidden and the SVG cannot take focus. |
| Input | Caller-owned nonempty id and visible label; text default, optional search/email/password. Explicit name/placeholder/required/autoComplete/disabled/readOnly/describedBy props. Controlled value requires onChange and excludes defaultValue; uncontrolled defaultValue/onChange excludes value. Nonempty error text implies invalid and adds `<id>-error` to describedBy. No placeholder-only name. |
| Pill | Noninteractive span. Neutral default; working/idle/review/blocked/done/triage/open supported. Readable status label default or nonempty custom label. Status dot is decorative. No live region or duplicate announcement. |
| Badge | Plain count or nonempty text-only discriminated props. Counts are nonnegative safe integers, max is a positive safe integer (99 default). Zero is visible. Overflow text is max+; hidden full numeric text carries the full count and optional consumer label. No action or urgency inferred from color. |

Native disabled wins over busy. Busy uses aria-busy and aria-disabled, retains native focus and the
same label/geometry, and guards pointer/Enter/Space/default submission activation. A static decorative
hourglass makes busy visible in reduced motion: Button reserves its token-sized cue slot in idle and
busy (an intentional idle-width change from rejected14f44), IconButton switches glyph/cue visibility
inside the unchanged fixed glyph slot. Original glyph stays in DOM, accessible names do not change. Focus-visible
is an independent outline with the approved gap/perimeter. Primary paints are always complete
state pairs; focus cannot override hover/active/busy paint. No opacity/filter/color mixing or
infinite animation is introduced. Icon target geometry is 32 compact / 44 cozy, separate from glyph.
Read-only input remains focusable; error sentences use primary text, not marker color alone.
Unbroken Badge text and Input label/error wrap inside narrow containers; native single-line Input
values keep their ordinary internal scrolling. New unbroken examples are actual story props, not
claimed from spaced-prose snapshots.

## Literal lint and counted exceptions

No raw style props or unrestricted prop spreads are forwarded. The accepted fail-closed lint
contract in `tools/token-lint.md` remains unchanged. Narrow same-line reasoned CSS escapes are
used for `border-box` sizing grammar, container maximum-width containment, label/error/badge `overflow-wrap: anywhere` grammar, and
standard visually-hidden clipping geometry. Each is counted by the real lint report. They do not
suppress paint/font/spacing values or neighboring lines. Exact final counts are checkpoint evidence,
not assumed from this document.

## Authoring and test surfaces

- Each atom has a TSX implementation, named Ladle state stories, and a component test file.
- Stories consume `ui/tokens/entry.css` and local fonts, not legacy styles or Google imports.
- Button/IconButton hover/active/focus stories require real pointer/keyboard interaction; attributes
  do not pretend to force browser pseudostates. Aggregate state panels also cover long labels,
  busy+focus, disabled+busy, Input controlled/uncontrolled/errors/readOnly, all Pill statuses and Badge0/overflow.
- Theme/density query controls are `atomTheme=light|dark`, `atomDensity=cozy|compact`; defaults dark/cozy.
- Browser configuration is import-safe metadata for Knip. Its static diagnostic output path
  `.test-results/atoms-unallocated` is not a runnable facility or server default. A real Playwright
  globalSetup in the existing fixture rejects missing private environment and executable before
  test/browser allocation; the worker rechecks it. An owned negative probe checks exact refusal
  and no Chrome profile allocation. No config ignore or implicit browser download is used.
- Browser fixture spawns its own Chromium using an ephemeral profile and connects over CDP.
  Explicit private loopback base URL and owned results/TMPDIR are required. No live ports or user Chrome.
- Proposed pinned visual matrix: five real state panels × light/dark × cozy/compact × width320/640.
  This is 40 initial Linux-only baselines, named for this component visual change. No images exist or
  browser/axe/font/glyph success is claimed until the actual pinned run and independent review.
- Seven local family/weight loads, HTTP font-byte hashes, custom-font glyph use on rendered Latin
  samples, actual axe results, native outcomes, primary paired colors and focus outlines are checked
  by the browser suite. Latin-only scope remains; no unsupported-script glyph claim.

Shared dependencies, UI strict/Vitest/Biome/Knip/check/CI and pinned browser-image intent belong to
lane B. Exact source-present approved patches precede executable checks. Build/serve/browser and
suite checkpoints require the coordinator's exclusive slot. Final review, independent verification,
coordinator rerun, and serialized integration remain mandatory.
