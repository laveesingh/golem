---
name: session-audit
description: Load when auditing a session or more for loaded context, execution weaknesses, inefficiencies, problem RCA etc.
---
<!-- GENERATED: skills/session-audit/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Context

Long running agents can run for hours and can have hundreds of turns, messages, tool-calls, decisions and more.
They receive some instructions about the workflow, how to behave, when to use certain tools and how to use them.
But they don't always behave in ways that are ideal or expected, because of their predicament or own volition.
With this we try to audit their sessions to identify problems, weaknesses or inefficiencies either in instructions,
tools or model choices.

# Who and where

The requested audits will mostly fall into the following categories:

**1. Investigating own session:**

In this case, you would be the agent investigating your own session. This way can you deeply assess and investigate
with your internal reasoning, choices and nuances, and the results through this are expected to be most insightful.
You likely hold all the context needed to do this audit, however, if the session has undergone compaction, reviewing
the detailed transcript would be required as well.

**2. Investigating another session:**

In this case, you'll be auditing another session, and if the session is currently live, you can directly message them
and ask them all your questions in one or two (not more) turns; additionally you can look at the corresponding detailed
transcript as well. But if the session is not live any longer, you'll rely on the detailed transcript.

**3. Investigating multiple sessions:**

This is similar to number 2, but you'll probably be asked something like "audit pi/cc sessions in the last 3 days", and you'll need to
investigate them all.

**Good to know:**

Agent sessions today live in either Pi or ClaudeCode, and their transcripts live in:
Claude Code: `~/.claude/projects/<dash-encoded-abs-path>/<session-uuid>.jsonl`
Pi: `~/.pi/agent/sessions/--<dash-encoded-abs-path>--/<UTC-timestamp>_<session-id>.jsonl`

# What and how

The purpose of auditing is to find the problems, weakensses and inefficiencies first. This require highly observant and
intelligent reasoning. Because some problems might be obvious, but most of them would be subtle, like:
* an agent decides to use the rest endpoint directly instead of preferred cli tool
* an agent decides to write a temporary scratch file, and make 10 updates fixing it before pushing it to a spec body
* an agent decides to write a script to do something that should've been a straightforward tool call
* an agent runs ci checks 100 times during the whole session, where only 5 times would've been sufficient

Essentially, we want to look through and find the potential issues of all observable types, but the most severe ones 
that might causing huge overhead w.r.t. token expense and execution time; stuff like some tools outputs too large for
the value the bring, agent over-fixating on something minor and keeps reiterating while wasting time and tokens both etc

And finally, lay down the identified issues, causes, rationale, and optional proposal into a large table. Include occurrences
and any other noticeable patterns that were observed. Just one table consolidated everything should be sufficient, no additional
essay around it is needed.

# The goal repeated

The goal is to identify issues in my setup of the harness, tools being used (like golem and others), model choices, instructions,
skills, workflow (spec driven), agent to agent collaboration mechanics etc, so I can iteratively fix and continue getting
the setup towards a better and better state.

