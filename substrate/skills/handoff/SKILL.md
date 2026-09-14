---
name: handoff
description: Load when I tell you to hand your context to another agent, or when a fresh session will continue your work.
---

# Handoff

Write a summary a fresh session can start from. It has no memory of this one. Deliver it by
notification to the agent I named (`golem:team-ops`); if I did not name one, ask.

Sweep your whole context, first message to last; after compactions the early part is what gets
lost. Capture only what would be lost with this session, not what the code, git history, or docs
already show. Under 60 lines, in bullets.

1. **Mission**: the goal, and the current sub-goal.
2. **State**: done (files, tickets, commits), in flight (uncommitted, half-done), not started.
3. **Decisions and why**: the ones reached through discussion that a new session would
   re-derive wrongly. State the reason with each.
4. **Landmines**: what looked right and was not, quirks, where time was lost.
5. **Next**: concrete steps, and the tickets they belong to.

Carry the approved target and authority limits explicitly: model/artifact/repo, local-only or
no-push constraints, and unresolved permissions. Handoff does not grant new authority.
