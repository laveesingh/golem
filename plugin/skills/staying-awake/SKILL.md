---
name: staying-awake
description: Load this at times when expecting a return response from a human or an agent.
---
<!-- GENERATED: skills/staying-awake/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Context

By default you go idle after your turn finishes, but there are scenarios where you need to stay awake
a big longer, and the way you can achieve that is by setting a reminder for yourself that wakes you
up after a few minutes.

# Situations

## After delegating to an agent

After you delegate some work to an agent, the agent is supposed to get back to you, and that's what
wakes you up. But sometimes, the agent might run into a technical error, or might simply forget to
get back to you directly. Then both of you stay idle and workstream dies. A better approach is for
you to set a check-up reminder for yourself after delegation after ~30 minutes to make sure you can
wake up and ask for status manually. And if the return had arrived prior to that, you can reset
that previous reminder from this turn onwards.

This goes on, for as long as you're waiting for an agent to return to you.
After which, if you are waiting for a human to respond to you, you can set up a similar reminder,
as also mentioned below.

## While discussing with a human

While waiting for me during a brainstorm or after a pause/terminal event with agents team, if I go
away for a bit, your session's KV-cache can go cold, and that is very expensive. A cache-cold turn
requires way more compute to re-prefill costs almost 10 times more than a cache-warm turn.
To avoid this to a reasonable extent, I need you to set a recurring reminder for yourself, and 
reset that at every human turn.

# What and How

Setting a reminder: `golem session notify --to self...`
Reminder duration for agent return: 25 minutes
Reminder interval for human return: 55 minutes in claude, 25 minutes in pi
