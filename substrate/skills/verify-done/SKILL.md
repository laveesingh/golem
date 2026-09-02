---
name: verify-done
description: Load before you accept any DONE, closing comment, or PR claim, or before you move work you own toward done. Confirms claimed evidence is real by re-running it.
---

# Verify done

A claim is not evidence. Only output you produced, artifacts you inspected, and comments you
checked count.

1. Read the acceptance criteria and the claim.
2. Re-run the claimed commands yourself, enough to prove the journey. UI: your own Chrome
   (`golem:browsing`).
3. Inspect the artifact: the file, the commit (`git log --oneline -5`, `git diff --stat
   HEAD~1`), the endpoint, the page. A PR: `gh pr view <n> --json
   state,mergeable,statusCheckRollup`, open or merged with green checks.
4. Record what you observed, and any check you could not run and why.
5. Conclude pass, fail, or incomplete. On fail, defects concrete enough to act on.

A claim you cannot verify is not finished; keep the ticket in its honest state. Whether the work
is right beyond the criteria is `golem:reviewing`.
