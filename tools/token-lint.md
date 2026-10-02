# Token literal lint: bounded syntax

The CLI checks UI sources, explicitly converted files, and their confined static CSS import closure.
It does not infer JavaScript bindings or types. This fail-closed contract supersedes the earlier
visible-style resolver and opaque-props allowance (GOL-438 `ef2702cb`, `08dcf1c9`).

## JavaScript / JSX / TypeScript

- A style expression must be a **direct object literal**. Property keys must be noncomputed
  identifiers or string literals. Values must be string or numeric literals accepted by the
  token/property checker: generated semantic/component `var()` references or the existing exact
  approved geometry/unitless/layout exceptions.
- A JSX prop spread must be a **direct object literal with static keys**. Its `style` member obeys
  the same style rule. A literal prop object with only non-style static keys is proved non-style;
  its ordinary values (for example a callback) are not style declarations.
- Unknown prop spreads, binding/alias/member/call/conditional style values, object spreads,
  computed/template keys, and TS-asserted style objects are unsupported. They report exactly
  `unanalyzable style expression` and cause exit 1. A const binding is not inferred safe.
- Standalone style-named object declarations and direct style-member assignments are also checked.
  This is not general JavaScript analysis. No known-props-type inference is claimed.

## CSS imports

Unconditional top-level `@import "local.css"` and `@import url("local.css")` (also quoted single
or unquoted URL) are followed recursively inside `dashboard/web`, with normalized cycle handling
and the existing exact source/generated/fonts/legacy-extra exclusions. Escaping/nonlocal/query/
escaped/dynamic/malformed imports and conditional/layer/supports tails fail explicitly.

## Counted line escape

Use a trailing actual comment on the **same physical source line** as the issue:

```tsx
const View = () => <div {...adapterProps}/>; // token-lint-disable-line: adapter owns validated geometry
```

```css
.adapter { width: 32px; } /* token-lint-disable-line: external adapter geometry */
```

- JS/TS requires a one-line `//` comment; CSS requires a one-line `/* ... */` comment.
- A nonempty reason is mandatory. The directive is exactly `token-lint-disable-line: <reason>`.
- Only declaration issues on that exact line can be escaped. Syntax/import/structural failures
  cannot be escaped. The directive cannot suppress another line or file.
- Missing reason, malformed/multiline/wrong-kind/duplicate-on-line or unattached directives fail.
  Directive-looking text in strings or ordinary prose is not a comment escape.
- Each applied inline directive is counted once, even if it suppresses several same-line issues.
  Existing exact file/property/value/owner/reason exception matches remain unchanged and are
  separately counted per matched declaration. No broad ignore or unreported suppression exists.
- The CLI summary reports `N escapes (I inline, E exact)` alongside file and issue counts.
