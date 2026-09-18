---
name: ingest-github-issues
description: Load when I ask you to ingest, pull in, or plan work from GitHub issues. Assess each issue against the current code, surface blockers, and turn it into a tracked spec or a plan.
---
<!-- GENERATED: skills/ingest-github-issues/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Ingest GitHub issues

I give you issue references (URLs or `owner/repo#N`). If I did not, ask.

1. **Fetch** each issue with its full comment thread (`gh issue view <N> --comments`). Several
   issues given together are parts of one task.
2. **Understand** the ask, the constraints, the prior discussion, the decisions already made.
3. **Assess against the code as it is now**: does the problem still exist, has the code moved
   on since filing, does the proposal fit the current architecture? Flag what is stale, fixed,
   or incompatible.
4. **Surface blockers and decisions first**: unknowns, ambiguous requirements, design calls
   that are mine. Do not proceed past an open blocker.
5. **Discuss with me** in chat. Post decisions the discussion produces back on the issue as a
   comment, so the GitHub record stays true.
6. **Ask me**: track it as a golem spec, or give you the plan?
   - Track: the issue plus the resolved discussion is the brief. Create the spec with
     `source_ref: "github:<owner>/<repo>#<N>"` at creation (it cannot be set later) and run the
     normal spec sequence (`golem:spec-driven-development`).
   - Plan only: scope, affected files, ordered changes, tests, risks, out of scope.

Return the spec id and its `source_ref`, or the plan. If blockers remain, return those and
create nothing.
