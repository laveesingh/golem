# Update guide: main 5.17.1 → 5.19.1 (28 commits)

You are on the old `main` (5.17.1). This checkout fast-forwards it to 5.19.1.
No data migration: existing tickets default to `markdown`, nothing is rewritten.

## Update steps

1. `git fetch && git checkout main && git pull` (fast-forward, no conflicts expected).
2. `npm install` (`package-lock.json` changed; also refreshes `mcp/channel` deps).
3. `golem sync --target cc && golem sync --target cc-marketplace`, then
   `claude plugin update golem@golem-workspace` + `/reload-plugins`.
4. Restart the dashboard from the new checkout (server + bundle changed).
5. Pi extension: reload once; reloads now keep the session bound (90s grace).

## What changed

- **Ticket CLI is canonical** (`golem ticket list/get/create/update/replace-body/get-outline/get-block/patch-blocks/add-comment/reply-comment/update-comment`). JSON-only stdout, file/stdin payloads, exits non-zero with machine-readable errors.
- **HTML spec bodies (specs only).** Sanitized fragments, stable per-block ids, `body_format`/`body_revision`, outline + block-patch routes. Dashboard has a format selector, block editor, and format-aware image paste.
- **MCP tools are now the compatibility surface** (Codex/OpenCode): reads + revision-gated full replacement only. Pi/Claude do ticket writes via the CLI.
- **Decision-led + collaboration cleanup:** CLI-first tool surface (`golem session notify/list` instead of `session_notify`), neutral return receipts, reusable SDD method, reminders live in `team-ops`.
- **Reliability fixes:** comment dispatch refuses implicit offline recipients (400), Pi reload keeps binding, dashboard block-editor/comment-anchor layout fixes.

## Might break → adaptation

| Old | New | Fix |
|---|---|---|
| Scripts parse `golem ticket` output with body/comments/events | Outputs are compact summaries only | Read bodies via `golem ticket get`; outlines via `get-outline` |
| Pi/Claude write tickets via MCP `ticket_create`/`ticket_update` | MCP writes are Markdown full-body only; no block ops | Use `golem ticket patch-blocks` / `replace-body`; create HTML with `--body-format html` |
| HTML writes without a revision | `400 expected_revision_required`; stale → `409` with current revision + outline | Retry with the returned revision (`get-outline` first) |
| Changing a ticket's kind freely | An `html` ticket can't become non-spec via kind PATCH | Convert format explicitly first (new body + `expected_revision`) |
| Comment auto-dispatched to some live session when assignee offline | Refused (`400`); drawer shows a recipient picker | Pick an explicit live recipient |
| `session_notify` / `sessions_dispatchable` in Pi/Claude tools | Removed from CLI-first surface | Use `golem session notify` / `golem session list` |
| Non-lead coordinating a spec | Allowed only on your explicit authorization | Authorize in chat or assignment; skill access alone grants nothing |
| Return messages with embedded `session_notify` syntax | Neutral receipts: sender id + recipient id + `golem:team-ops` pointer | Follow the pointer, don't parse syntax |

`--human` marks human-shell mutations; bound agents must not use it. Reads from unbound contexts need `--project`.
