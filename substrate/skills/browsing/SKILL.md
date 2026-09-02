---
name: browsing
description: Load before any browser work — browsing, scraping, UI checks, screenshots, devtools automation, anything behind a login. One Chrome launch for every harness, the shared logged-in profile, the login handoff, and what you may do on authenticated sites.
---

# Browsing

## Launch your own Chrome

Drive Chrome over CDP against an instance you spawn. Do not use a harness's built-in browser
integration; they differ per harness and fail unevenly.

```bash
rm -f "<profile dir>/DevToolsActivePort"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --user-data-dir=<profile dir> --remote-debugging-port=0 \
  2> <scratch>/chrome-stderr.log &
```

(`google-chrome` on Linux.) Port 0 picks a free port. The endpoint is the `DevTools listening on
ws://…` line in that stderr log; `DevToolsActivePort` is the fallback. HTTP endpoint:
`http://127.0.0.1:<port>/json`. Drive it with the project's CDP client (playwright-core, a raw
WebSocket).

Headless by default. Headed only for the login handoff, or a task that is explicitly visual.

## Profiles

| Profile | When | How |
|---|---|---|
| Ephemeral (default) | no login needed | fresh temp `--user-data-dir`, deleted on exit |
| Shared | the task needs my logins | `~/.golem/chrome-profile/`, one instance at a time (Chrome locks it) |

Never delete, reset, or log out of the shared profile.

## Login handoff

When you hit a login wall on the shared profile:

1. Close your instance; the lock must be free.
2. Relaunch plain Chrome, headed, without `--remote-debugging-port`:
   `open -na "Google Chrome" --args --user-data-dir="$HOME/.golem/chrome-profile"`. Identity
   providers refuse sign-in when a debug port is open.
3. One line in chat: which site, and what you continue with after.
4. Hands off until I say "done" in chat.
5. Close that window (`pkill -f -- "--user-data-dir=$HOME/.golem/chrome-profile"`; it holds the
   lock) and relaunch with the debug port.

When I am away, a missing login is a missing credential: comment the blocker on the ticket, set
`blocked`, close the window, move on.

## Authority on authenticated sites

Read-only is always in scope. Writes are in scope exactly as far as the task names them.
Payment, irreversible account actions, and anything beyond the mandate go to me first. When
unsure whether the mandate covers a write, it does not.

## Hard rules

- Never attach to my desktop Chrome (port 9222 or any other). Drive only what you spawned.
- Kill what you spawn. Screenshots and scratch scripts go to your scratchpad, not the repo.

## Gotchas

- `DevToolsActivePort` survives clean exits stale and can point at someone else's Chrome after
  a lock abort. Hence the `rm -f` first, and your own stderr line as the source of truth. No line
  within a few seconds: the launch failed; read the log.
- Headless traffic can trip bot detection despite valid cookies. Report it; do not retry.
- A headed window left open on the shared profile blocks every other agent. Close it.
