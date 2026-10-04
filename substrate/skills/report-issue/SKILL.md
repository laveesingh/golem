---
name: report-issue
description: Load when something in golem misbehaves and I ask you to diagnose it or file it. Reproduce first, then route: real repo bug to GitHub, local trouble to a tmp fix-it note.
---

# Report issue

I describe a symptom around golem (sync, dashboard, tracker, hooks, plugin). If I did not,
ask what broke and which command I ran.

1. **Reproduce** on my checkout: run `golem doctor` and `golem sync --check --all`, and note
   the `node` version plus the installed plugin version against `package.json`. Read the
   failing code and rerun the failing command. No repro, no issue.
2. **Classify**: a repo bug only when it reproduces on a clean checkout (`git status` clean,
   fresh `npm install`) and the fault sits in committed code. Stale `node_modules`, OS
   permissions, herdr versions, config under `~/.golem`, or an unrendered sync stay local
   until proven otherwise.
3. **Dedup**: search open issues (`gh issue list --search "<symptom>"`) against this
   checkout's repo (`gh repo view --json nameWithOwner`), falling back to `laveesingh/golem`.
   An open match ends the job — link it instead of filing.
4. **Summarize in chat**: symptom, repro steps, versions, suspected owner file. Then ask me:
   file it, or treat it as local?
   - File, only on my yes: `gh issue create --title "<area>: <symptom>" --body "<summary,
     repro, versions>"`. Return the issue URL.
   - Local: write `$TMPDIR/golem-fix-<slug>.md` (never inside a repo checkout) with the
     diagnosis and the exact commands to try, cheapest first. Return the path plus the first
     command.

Never file for a local-only cause. Never file twice for one symptom. Never write the fix-it
note inside a repo.
