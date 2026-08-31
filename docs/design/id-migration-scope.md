# Scope: Migrating URLs from global TKT-#### to project-scoped IDs only

**Status: scoping only — no code changed.** Use this to decide whether to pursue.

**Current:** Every ticket has two ids. `TKT-0644` is the global, monotonic SQLite `id`/`seq`. `YIT-109` is the project-scoped `display_id` = `PREFIX-pseq` (e.g. `yitfit-6323e5` → `YIT`, `golem-38ab8a` → `GOL`). `pseq` is per-project and allocated inside `allocateTicketId()` in `dashboard/server/tracker-db.js:1426`, with `project_prefixes` guaranteeing prefix uniqueness and `idx_tickets_display UNIQUE(display_id) WHERE NOT NULL`. The UI already shows `display_id` where it can (`ticket.display_id || ticket.id` in ~12 places) and the router builds `/read/:display_id` (`router.js:132`). The server accepts *both* via `resolveTicketRef()` (`index.js:593` → `tracker.getTicket(id) || getTicketByDisplayId(id)`), so `/api/tickets/TKT-0644` and `/api/tickets/YIT-109` both resolve today.

**Ask:** Drop `TKT-####` from every external surface and treat `YIT-109`/`GOL-287` as the only ticket identifier — in URLs, API paths, store keys, links, and any user-visible string.

## Where TKT leaks today (blast radius)

| Surface | Examples | What would need to change |
|---|---|---|
| **Router & URLs** | `router.js: parseRoute /read/:id`, `buildHref` `/read/${id}`, deep-link overlays `?ticket=`, `?compose&parent=TKT-0284` | Make `buildHref` and deep-link generation emit `display_id`; keep `parseRoute` accepting `TKT-` only for a redirect, or remove that branch. |
| **Server API** | `index.js: resolveTicketRef` on every `/:id` route (tickets, comments, dispatch, links, revival, assets, search snippets return `display_id` but accept both) | Switch validation to require `display_id` shape, add 308 from `TKT-` → `display_id` during a grace period, then drop `resolveTicketRef` fallback. |
| **DB & store** | `trackerTickets` Map keyed by global `id` (`store.js`, `ticket-drawer.jsx: trackerTickets.get(ticketId) ?? find(display_id)`) | Re-key store by `display_id` or keep dual-key lookup during transition; `id` would become an internal FK only. |
| **Links & references** | Ticket links `links` (`to_ticket`), `parent_id` (spec children `SpecChildrenPanel`, worktrees), comment `parent_id`, markdown bodies containing hard-coded `TKT-` strings, asset URLs `/api/ticket-assets/...` (ticket-agnostic) | Migrate `parent_id`/`to_ticket` to store `display_id`, or translate on read/write; rewrite bodies via a one-time DB migration + mark `TKT-` in bodies as deprecated. |
| **Worktrees & git** | `AGENTS.md` “Parallel Work = Worktrees” says `\.worktrees/<ticket>-<slug>/`, `branch: feat/<ticket>-slug`, render paths `~/.golem/renders/` | If worktrees/branches were named with `TKT-` they’d need renaming or a mapping; new ones would use `GOL-287`. |
| **CLI / MCP / Go tools** | `cli/golem.js`, `mcp/channel/tracker-client.test`, `go` dispatch payloads carry `ticket_id` | Every tool that prints or accepts an id must be updated; MCP `tracker` tool `ticket_get GOL-287` already accepts either. |
| **Search & dispatch queue** | `searchTickets` `display_id LIKE`, `dispatch-queue` rows reference `ticket_id` (global), `pending_dispatch` | Rewrite `ticket_id` FK in queue tables to `display_id`, or keep internal join. |
| **External integrations** | Slack/webhook briefs (`dispatchBrief` uses `ticket.display_id \|\| ticket.id`), gate files, docs `REPO-MAP.md`, `substrate/templates/` examples referencing `TKT-` | Hunt-and-replace, plus any external bookmarks/screenshots that embed `TKT-` URLs break without redirect. |
| **Historical data** | 644 tickets with both ids persisted; `specs/` markdown files, `docs/adr/` already use `YIT-` in titles? | One-time backfill: ensure every row has `display_id` (old smokes already backfilled in v6 migration), then lock new creates to `display_id`-only. |

## Two implementation shapes

### 1) Soft hide (keep global id internally, hide externally) — ~0.5–1 day

* Change `buildHref`, `openTicket`/`openComposer`, and every `ticket.display_id || ticket.id` call site to use *only* `display_id` (fail-closed if missing).
* Make `resolveTicketRef` still accept `TKT-` but log a deprecation warning and 308-redirect `TKT-` URLs to `display_id` URLs — bookmarks keep working.
* Keep DB `id` as primary key; all FKs stay `TKT-`; store’s `trackerTickets` Map stays keyed by `id` but UI never renders it.
* Effort: touches ~15 files (`router.js`, `index.js` presentation helpers, 4 web views, `store.js` fallback path). No migration. Rollback is just revert.

**Why consider it:** Gives you the UX you asked for (YIT-109 everywhere, TKT never shown) without a data migration. Cost is a small indirection layer (“which key is this reference?”) that stays forever.

### 2) Hard cut (display_id becomes the identity) — ~2–4 days + coordination

* Same UI changes as (1) **plus**: change DB primary references so `parent_id`, `to_ticket`, `pending_dispatch.ticket_id`, `comments.ticket_id` store `display_id`; change map keys; drop the `resolveTicketRef` fallback after a deprecation window.
* Run a one-time migration inside `tracker-db.js` transaction: rewrite every FK column, rebuild indexes, set `id` column to `display_id` or drop it (keeping `seq` for monotonic ordering if needed).
* Deal with collisions on hard-coded `TKT-` in markdown bodies: regex-rewrite or keep a legacy `tkt_to_display` table for read-time translation.
* Deal with filesystem artifacts: rename `\.worktrees/*`, branch names, `~/.golem/journals/<project>`? (project-scoped, not ticket-scoped — unaffected), and any CI that greps `TKT-`.
* Communicate breakage: every copy-pasted `TKT-0644` link stops resolving unless we keep a permanent redirect. If you truly want *no* global ids, you accept that breakage.

## Effort / risk rubric

* **Implementation complexity:** soft = low (UI-only, ~30 LOC + 3 files + 1 redirect); hard = medium-high (touches persistence, FKs, worktree naming, docs). Neither needs a framework change.
* **Data risk:** soft = none (no rows rewritten). Hard = needs an offline sweep and a backup; the `idx_tickets_display` uniqueness already protects against prefix collisions, but any manual `TKT-` in bodies that isn’t migrated will become a dead link.
* **URL/product risk:** soft = back-compat forever (TKT links keep working). Hard = breaking — every external reference (Linear/GitHub comments pasting `TKT-`, user bookmarks) 404s unless you keep the redirect, which is really soft again.
* **Readability/maintainability:** soft leaves a dual-key mental model for future contributors (“is this an id or a display_id?”). Hard simplifies the model to one key but pays the migration and the breakage.

## Recommendation

Given the request is *scoping*, the pragmatic path is to **ship (1) now** — make `/read` and every UI string emit `display_id` only, keep `TKT-` as a server-side alias with a redirect and a deprecation log. That satisfies the two complaints you raised (identity + deep-link clarity) without forcing a flag-day rename of worktrees, stored bodies, and external links.

Promote to (2) only if the permanent dual-key confusion becomes a real maintenance cost — i.e., you keep finding contributors or agents writing `TKT-` when they mean `YIT-109`. The migration script itself is writeable in an afternoon; the coordination (announcing the break, double-writing both ids for a window, scrubbing bodies) is the bulk of the 2–4 day estimate.

## Open questions before a go/no-go on (2)

* Do we want `TKT-` → `display_id` 308 to be permanent (then (2) is really (1) with extra internal renaming for tidiness)?
* Which surfaces are allowed to keep `TKT-` during the window — just server logs, or also `git branch -a` output that contributors see daily?
* Do hard-coded `TKT-` in markdown bodies count as tech debt to scrub, or as history to leave verbatim?

*No files changed beyond this doc; next step is your pick among lab options A–E for the first two problems, and a pick of (1) vs (2) here.*
