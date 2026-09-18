---
name: skill-authoring
description: Load when you write or revise a skill, a role card, or Global Rules — a SKILL.md, its description, or a persona body. Scope, structure, voice, caps, and the editorial pass. Not for runtime or enforcement design.
---
<!-- GENERATED: skills/skill-authoring/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Skill authoring

An instruction file exists to change what an agent does. Every line must change an action, a
decision, or an interpretation. Delete the rest.

## Before you write

1. Read the target file, the files that point at it, and the source of any fact you will
   state. Separate facts, my decisions, and your assumptions.
2. Say in one sentence what this file changes in an agent's behaviour. If you cannot, the
   file has no job.
3. Find the owner of every rule you are about to state. A rule has one owner; every other file
   points at the owning skill and heading. `golem sync --check` fails on a second
   full statement of an owned sentence and on a pointer that does not resolve.
4. Know the cap: `lib/compiler/lint.js` lists the word cap for every file. Fit the cap by
   cutting rationale, not by compressing method.

## Shape

- Front matter: `name` matches the directory; `description` says what the skill does and when
  to load it, in the words a session would use ("Load when …"). It is the only routing
  surface; a job that moved into this file must appear in its description.
- Role skills: Inputs · Steps · Returns · Boundaries. Shared and situational skills: the
  smallest set of headings the job needs.
- Prose carries method and judgement; tables carry mappings and comparisons; numbered lists
  carry order. Do not compress a method into one-line cells.
- A diagram only for a branch or loop the text cannot show. Never for a linear sequence.
- Conditional material goes in a `references/` file with a stated read condition. Core rules
  never hide there.

## Voice

Write as my preferences, first person, with the reason where the rule is not obvious. Short
sentences, plain words, active voice, one term per concept. State what to do; a prohibition
only for an irreversible action, paired with the action to take instead. No history, no
reassurance, no words like "canonical", "load-bearing", "choreograph".

Before:

```markdown
- Review the code carefully when needed and follow best practices.
```

After:

```markdown
Trace the changed path from entry point to side effect before you judge it.
Report a finding only after re-reading the code that proves it.
```

## Editorial pass

- [ ] Every line changes an action; no generic advice, no restated context.
- [ ] Each rule has one owner; pointers resolve; `golem sync --check` is clean.
- [ ] The description routes the job; the cap holds.
- [ ] Facts come from sources you read.
- [ ] Nothing in the file contradicts Global Rules, the role cards, or another skill. Grep
      for the rule's key phrase across `substrate/` to be sure.
