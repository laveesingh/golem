---
name: handoff
description: Load when I tell you to hand your context to another agent, or when a fresh session will continue your work.
---

# Handoff

Write a detailed context handoff about the work in your session so far. It is intended for either
a peer session or a successor of this session.

**Include**: In the handoff, include the intent, goal, the high level objectives that we'd been
working on. Provide an emphasis on decisions, underlying reasoning, essential nuance to understand.
**Progress**: Include what the current state of things is, what's already done and and what's left.
**Pitfalls & Landmines**: Anything to watch out for.
**Execution Preferences**: Anything in particular that was explicitly authorised, unauthorised, requested w.r.t.
to execution sytle and preferences. Any boundaries, constraints etc.
**Emphasize**: Put more foucs on recent, active and todo things, less emphasis on older, settled or
abandoned htings.

**Send**: By default, the handoff is created as a md document under ~/.golem/handoffs.
But if an agent was named then use `golem:team-ops` to send it as a mesasge directly to that agent.
