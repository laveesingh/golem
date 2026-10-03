---
name: staying-awake
description: Load this at times when expecting a return response from a human or an agent; used by lead and orchestrator roles.
---
<!-- GENERATED: skills/staying-awake/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Staying awake

Context: By default you go idle after your turn finishes, but there are scenarios where you need to
stay awake a bit longer, and the way you can achieve that is by setting a reminder for yourself that
wakes you up after a few minutes.

## Setting a reminder

* `golem agent notify --to self --message "check return" --after 25m --json`

## Waiting for an agent

* Set reminder after delegating to an agent and when expecting agent to get back to you
* If agent returns before reminder wake, cancel the reminder/schedule, and decide afresh on next delegation, if any
* If agent does not return before reminder wake, ping agent for status update
* If status nothing arrives still until next reminder wake, you can read agent terminal output and infer and decide from there.
* Reminder interval: 25 minutes

## Waiting for me/human

* While waiting for me during/after brainstorm/spec-review or after a pause/terminal event with agents
* When I return and get back to you, you can reset the reminder frequency and count
* When I don't return: at wake, just say "staying awake" and that's it. Don't do anything that turn.
* Reminder interval: 55 minutes if you are in claude code, 25 minutes otherwise (e.g., pi)
* Reminder max count: 6 if you are in claude, 10 otherwise

## Context dump
* In case, human does not return until last wake, do a context handoff dump before going idle. Create a handoff file under ~/.golem/handoffs/ with name like `<date>_<session_name>_<workstream_title>.md` with the purpose so that your successor receives it in case your session is not continued. And in chat write a short prompt that I can simply copy paste to your successor that will read the handoff with file location and can continue from there.
