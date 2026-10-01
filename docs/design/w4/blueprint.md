# W4 design foundations — isolated handoff

## Status and boundary

Design checkpoint for **Engineering standards for the brownfield**, GOL-438 ES-05/06,
revision 6; task **W4 prerequisite-light design**, GOL-466. Base `b0ab579`.
Not production W4 implementation, a chosen shell, or visual acceptance.

Everything authored here is isolated. `design-lab/index.html` and `README.md` are intact
copies of the human's untracked main-checkout files. Do not port the lab into the product.
No production UI, tools, package, runner, schema, backend, global render, or live runtime changed.

## Grounding and reuse

| Source | Observed contract | Consequence |
|---|---|---|
| GOL-438 ES-05 | DTCG 2025.10; primitive → semantic → component; light/dark; cozy/compact; AA; literal lint | Assets use these layers and sets, not a second vocabulary |
| GOL-438 ES-06 | Ladle, Testing Library, axe, pinned Linux screenshots, self-hosted fonts | Builder owns those consumers after W2 |
| GOL-431 revision 2, D-12 | A compact sidebar, B workspace rail, C header-led; shell row remains **open** | No shell dimensions or product navigation chosen here |
| `dashboard/web/styles.css:5–210` | Four palettes; radius 4/6/8; Geist and JetBrains Mono import; 2px focus + offset | Reuse existing values; tokens expose roles, not palette names |
| `dashboard/web/src/tweaks.jsx:6–39` | `golem.tweaks.theme`; valid dark/loam/graphite/nocturne; absent/invalid defaults to nocturne; six accent ids | Migration mapping below is a blueprint, not a storage write |
| `dashboard/web/src/atoms.jsx` | ConnectionPill; Avatar uses Store; shared modal stack, inertness, focus restoration | New atoms stay data-agnostic; preserve existing drawer authority |
| `dashboard/web/src/field-controls.jsx` | PopSelect has arrows, Enter, Escape, type-ahead/filter, portals | Menu blueprint must preserve keyboard and portal behavior, not redesign it |
| `dashboard/web/extra.css` | Legacy literals and reduced-motion rules | Exempt legacy island; do not claim it is tokenized |
| Copied lab `.app` tokens and compact control | System sans/mono stacks; `--sp: .82`; body 13.5→13; different blue accent | Reference only. Not evidence that its palette/font/shell is approved |

Canonical asset palettes reuse **Nocturne**, the current default, for dark and **Loam**,
the existing light mode, for light. This does not select a GOL-431 shell or a new theme.
The compact set uses explicit existing 4px-grid values, not the lab's fractional multiplier.
Body size stays 14px in both densities; only geometry changes. Compact is not small-text mode.

AA remapping, not a new direction: light muted/disabled text uses existing `--text-1`
(`#454238`); dark muted/disabled text uses existing `--text-2` (`#b2bbb7`). Existing darker
metadata values are not safe for all supported surfaces. Required control outlines use the
existing primary text (light) / tertiary text (dark), not decorative hairline borders.
Status-colored dots/icons are limited to page/panel/raised backgrounds and 3:1 checks;
status labels always use `text.primary`, not colored body-sized text.

## Files and ownership

- `tokens/*.tokens.json`: seven DTCG-shaped source sets, complete-token overrides.
- `sets.json`: explicit composition order and isolated defaults (dark/cozy).
- `contrast-pairs.json`: 56 declared usage pairs; `generated/contrast.json`: both themes, 112 calculations.
- `fonts/`: seven unmodified Latin normal WOFF2 files, two licenses, inventory, local `@font-face` CSS.
- `prototype.mjs`: isolated generator/validator sketch; `static-check.mjs`: bounded artifact probes.
- `generated/tokens.css`, `tokens.ts`: deterministic design exemplars, not production imports.
- `provenance.json`: package integrity, file hashes, lab-copy and grounding fingerprints.

Builder ports source tokens and fonts into `dashboard/web/src/ui/{tokens,fonts}/` after W2.
Builder implements production `tools/tokens-build.ts` and `tools/lint-tokens.ts` in W4; the
prototype is guidance, not a production entry point. No package installation performed here.

## Token and generator contract

1. Compose primitive, base semantic, theme semantic, density semantic, component.
   Only theme may override semantic colors; only density may override `semantic.density.*`.
   Each known override keeps its declared type and replaces the whole token, not subproperties.
   Reject accidental duplicate definitions outside those explicit override paths.
2. Groups are nested JSON objects. Leaves have explicit `$type`, `$value`; optional descriptions
   and extensions are metadata. Names here are ASCII alphanumeric segments, starting with a letter.
   Dots join path segments; dots/braces inside segments are invalid.
3. Semantic tokens reference primitive tokens. Component tokens reference semantic tokens.
   Components consume **only** semantic/component names. No literal values above primitives;
   no back edges or cross-layer shortcuts. Resolve with visited/visiting sets before layer checks,
   so cycles produce `CYCLE`, not a misleading layer error. Reject unresolved/type-changing aliases.
4. Bounded authored subset: opaque `srgb` color object with three [0,1] components and `alpha:1`;
   nonnegative finite dimension `{value,unit: px|rem}`; nonnegative duration `{value,unit: ms|s}`;
   typography composite with fontFamily array, dimension fontSize/letterSpacing, numeric fontWeight
   1–1000 and positive numeric lineHeight multiplier. Whole-token curly-brace aliases only.
   Composite typography values are literal primitives; semantic/component typography aliases them.
5. This is **not a fully conforming DTCG parser**. Explicitly reject `$ref`, `$extends`, `$root`,
   type inheritance, partial/property aliases, unknown types and unsupported composites. Do not
   silently stringify them. Full DTCG support, gradients, shadows, z-index and alpha compositing
   need separate builder extensions when a converted consumer requires them. Legacy styles keep
   their existing shadows/patterns until their slice; no raw shadow-string escape in new UI.
6. CSS prefix is `--g-`, logical dots become hyphens; retain case. Resolve values to literals
   and emit semantic/component variables only. No public primitive CSS. Sort names by Unicode
   codepoint comparison, never locale-dependent sort; LF, fixed indentation, final LF, no timestamps.
7. Selectors, in order: `:root` defaults; `:root[data-theme="light"]`,
   `:root[data-theme="dark"]` override color variables and `color-scheme`;
   `:root[data-density="cozy"]`, `:root[data-density="compact"]` override density variables
   and affected component aliases. Independent selectors make light+compact work without joint
   selectors. Attributes belong on documentElement; portals inherit the same root variables.
8. Typography emits a `font` shorthand variable plus `-letterSpacing`. Apply both; a font
   shorthand does not carry letter-spacing. Generated `tokens.ts` exposes read-only logical-name
   → `var(--g-...)` entries (including typography `.letterSpacing`) and `TokenName` union.
   Reject CSS-name collisions, including synthesized member names. Builder should add type-specific
   unions so a color cannot be passed to a spacing prop; the prototype emits names only.
9. Last `@media (prefers-reduced-motion: reduce)` zeros all duration variables. Component authors
   must also remove infinite animation/smooth-scroll and avoid transition-dependent completion.
10. Validate all four combinations before output. For each declared color pair, convert encoded
    sRGB to linear (`c/12.92` at c≤.04045, otherwise `((c+.055)/1.055)^2.4`), luminance
    `.2126R+.7152G+.0722B`, ratio `(lighter+.05)/(darker+.05)`. Compare unrounded ratio to 4.5
    body text / 3 UI. Round only the report. Fail whole build on any violation; do not auto-adjust.
    Alpha or an undeclared foreground/background pairing is unsupported, not assumed accessible.
11. Production builder writes CSS/TS together only after all validation, or leaves previous output
    intact on error. `--check` regenerates in memory and compares bytes, never writes. Error records
    carry file, token, set and code; exit 1. Bad command arguments exit 2. Prototype does not claim
    atomic writes, duplicate JSON-key detection, complete overlay-scope/collision checks, or those CLI
    behaviors. Builder must implement and mutation-test them before port acceptance.

## Appearance preference mapping blueprint

| Existing persisted preference | New root attribute | Notes |
|---|---|---|
| `loam` | `data-theme="light"` | Sole current light mode |
| `dark` | `data-theme="dark"` | Original dark collapses to canonical dark; not a promise of identical pixels |
| `graphite` | `data-theme="dark"` | Preserve original id as migration input, not a third exposed theme |
| `nocturne` | `data-theme="dark"` | Current default; canonical dark palette grounded here |
| Missing/invalid/unreadable | `data-theme="dark"` | Match current nocturne fallback; no live storage read performed |
| No density preference | `data-density="cozy"` | Locked W4 baseline |
| Explicit compact | `data-density="compact"` | Explicit preference, never inferred from viewport |

Do not edit storage in the designer lane. Read old preferences before first paint; translate at
one adapter boundary, then hand semantic root attributes to UI. Keep the legacy id available to
the legacy island if needed. Existing custom accent ids are not removed or remapped by these
assets: retain legacy behavior inside the island; do not inject unchecked color overrides into
new tokens. A shell/product decision must settle that control before it moves into new UI.
Do not introduce a new global system-theme preference, settings menu, or shell width.

## Literal-lint contract for builder

Parse CSS declarations and JSX/TSX inline style/object syntax, not regex over file text.
Check `src/ui/**` plus an explicit monotonic converted-file manifest. Scan stylesheets imported
by converted components too. Exclude canonical token source, generated files and `ui/fonts`
font-face metadata; exclude legacy `extra.css` explicitly, never all legacy-looking filenames.
Comments, prose, URLs, selectors, class names, aria numbers and SVG path geometry are not CSS values.

Reject hex/rgb/hsl/color functions/named colors; px/rem/em/vh/vw/% lengths; border-radius literals;
font family, size, weight, shorthand and letter-spacing literals. Also reject numeric inline style
lengths (React implicitly adds px), template-built raw lengths and untyped dynamic style colors.
`var()` must name a generated semantic/component token. No literal fallback in `var(--token, 8px)`.
`calc()`/`clamp()` do not hide nonzero lengths. No direct `primitive` reference or handwritten alias.
Dynamic geometry belongs in a narrow documented adapter, not an arbitrary exempt component prop.

Legitimate property-aware exceptions only:

- Unitless zero for zero-capable geometry (margin/padding/border/outline/offset); `0px` fails: use `0`.
- Unitless scalar opacity 0/1, flex grow/shrink, grid line indices, transform scale, font-independent
  line-height multiplier: dimensionless CSS grammar, not a substitute spacing scale. Fractional opacity
  requires a semantic token before use; avoid text-opacity contrast loss.
- `auto`, `none`, `inherit`, `initial`, `unset`, `normal`; CSS layout keywords and `minmax(0, 1fr)`.
  Permit `100%` only on fill width/height of a layout container, not spacing/radius/font properties.
- `transparent` for genuinely absent paint, `currentColor` for icon stroke/fill tied to parent token;
  neither for body text or an accessibility-critical control outline.

Explicit allow records name file/property/value/rationale and owner; exact match, no blanket
line disables. Missing/unrecognized exception fails. Print file:line:column/property/code; exit 1.

| Mutation / example | Expected |
|---|---|
| `padding: 12px`, `border-radius: .5rem`, inline `{width: 32}` | fail LENGTH/RADIUS |
| `color: #fff`, `background: rgb(1 2 3)`, `font-family: Geist`, `font-weight: 600` | fail COLOR/FONT |
| `calc(var(--g-semantic-density-gap) + 2px)` or var fallback literal | fail LENGTH |
| `var(--g-primitive-space-n8)` or unknown `var(--g-foo)` | fail LAYER/UNKNOWN_TOKEN |
| `var(--g-semantic-density-gap)`, `margin: 0`, decorative SVG `stroke: currentColor` | pass |
| `padding: 100%`, text `color: transparent`, new unregistered exemption | fail |
| Add same literal in a newly converted file or imported CSS | fail; legacy extra.css still exempt |

No literal linter is implemented or claimed here. Builder tests every mutation above plus
comments/strings/data URI false positives and source/generated exclusion before enforcing CI.

## Five atoms / four molecules for first W4 port

Recommendations fit all three lab shells; they are not production components.

| Layer / name | States and semantic use | Keyboard / aria obligations |
|---|---|---|
| Atom Button | default, hover, active, focus-visible, disabled, busy; primary/quiet; stable label and size | Native button; Enter/Space; type=button default; busy aria-busy with meaningful label; no duplicate action |
| Atom IconButton | same states; density.target separate from visual glyph | Accessible name required; decorative icon aria-hidden; focus ring not clipped; ≥24px hit target (32 compact / 44 cozy) |
| Atom Input | empty, populated, placeholder, focus, invalid, disabled, read-only | Native input + id/label; aria-invalid and describedby error; read-only focusable; no placeholder-only label |
| Atom Pill | neutral and working/idle/review/blocked/done/triage/open; long label | Text label plus decorative status dot; not clickable by default; no redundant live announcement |
| Atom Badge | zero, small/large count, overflow label, text-only | Not a button; full accessible count; do not convey urgency only with color |
| Molecule Card | empty/populated/loading/partial/error, long strings, nested actions | Heading association; avoid clickable article with nested buttons; actions explicit; aria-busy scoped |
| Molecule ListRow | selected/unselected, hover/focus, disabled action, overflow | Link or button only when actionable; aria-current for navigation, not generic selection; child controls not nested |
| Molecule Menu | closed/open; no options; active/selected/disabled; long list; searchable variant | Trigger expanded/controls; listbox semantics for selection, menu for commands (never mix); arrows/Home/End/typeahead; Escape closes top overlay + restores focus |
| Molecule SearchField | Input + clear IconButton; empty/query/busy/no matches/error | Label; clear named; Escape clears only when specified by consumer; status via scoped polite region, not every keystroke |

Generic component tokens provide semantic states; they do not prescribe product data. `busy`
uses stable geometry and text, not opacity. In reduced-motion mode use a static busy indicator.
InvalidColor/status colors are UI markers on approved surfaces; an error sentence is primary text.
Color alone never represents selected, busy, invalid or status. Story fixtures include extremely
long labels, keyboard-only paths, zero counts, narrow 320px container and reduced motion.

For each: TSX implementation, Ladle story per state, Testing Library behavior/keyboard/aria tests,
axe checks and pinned Linux screenshot artifacts under the locked ES-06 contract. Atoms and
organisms require screenshot baselines for each theme at fixed width. Molecules get the four-artifact
checklist too; do not infer that the smaller W4 sample excuses missing states. Cross density is a
layout assertion and workshop control; independent screenshots where density changes geometry.

## Font inventory and deterministic visual gates

Current production imports Geist normal 400/500/600/700 and JetBrains Mono normal 400/500/600.
Assets match exactly those families/weights; no italic or extra subset fetched for runtime.
Fontsource package versions both **5.3.0**, unmodified distribution binaries. Inventory records
upstream Google Fonts metadata versions Geist v5 / JetBrains Mono v24, attribution, package URL,
subset, bytes and SHA-256. `provenance.json` records npm SHA-512 integrity; LICENSE files ship with
assets. OFL permits redistribution subject to its license; do not remove attribution or rename
modified fonts under reserved names. No proprietary Avenir/Charter/SF Pro files copied.

Lab uses system fonts; Loam uses Avenir/Charter in legacy production. This checkpoint does not
claim font-pixel parity or approve their replacement in a picked shell. Builder's new UI uses the
locked self-hosted foundation; legacy typography remains scoped until conversion. Latin-only
coverage is a deliberate bounded first asset set; unsupported scripts/glyphs fall back to the
mono/sans stacks and are not deterministic. Add a required licensed subset before such a fixture
becomes a screenshot baseline. Locale and glyph coverage remain browser gates, not hash checks.

Builder loads `fonts.css` locally through token entry (no Google runtime import). Before visual
capture await `document.fonts.ready` **and** assert each required family/weight loads successfully;
ready alone also resolves after a failed download. Pin Linux image/browser, viewport, device scale,
locale/timezone, clock and ids; reset store/localStorage; disable animation; fail on font/network
errors; do not regenerate baselines on macOS. Neither browser load nor glyph rendering ran here.

## Legacy island journey and remaining gates

Shell adapter hosts legacy pages on the existing single React root, never a second root/store.
Scope legacy selectors so they cannot recolor new components; root semantic tokens reach portals.
Retain drawer stacking, inertness, top-layer Escape and focus restoration. Real-page e2e must enter
an existing ticket page from the shell, open a drawer/listbox, navigate with keyboard, dismiss the
top overlay only, restore focus, submit a safe isolated change and verify the existing route/store
receipt. Run light/dark, density, reload preference translation, overflow and error states. A mocked
organism story cannot replace this journey.

Run now, from this worktree: `node docs/design/w4/prototype.mjs`;
`node docs/design/w4/static-check.mjs`; `git diff --check`; verify copied lab bytes via `cmp`.
Reports are arithmetic checks of declared pairs, not rendered-page accessibility or visual approval.

After W2: builder ports assets, implements generator/lint and independent failure tests, creates
Ladle + four-artifact component sample, removes runtime font fetch when that production slice is
touched, checks real isolated pages with axe and screenshots, and runs legacy island journey.
Fresh review + independent static verification precede coordinator integration. No spec-branch
merge without an explicit slot. W4 completion remains unimplemented.

Reference: DTCG Format Module 2025.10, https://www.designtokens.org/tr/2025.10/format/
(consulted for color/dimension/typography and alias shapes; bounded parser limits above).
