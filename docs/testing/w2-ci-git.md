# PR51 container Git repair — GOL-479

This is a planner-authorized CI-only spec commit from a82ad10. W3 package/type/source work remains paused and untouched.

## Observed and inferred

Observed runs36924986956(pull_request) and36924986468(push): test jobs and npm run check succeed; final git diff --check exits129, Not a git repository. Full log /tmp/gol438-actions-check-full.log shows Git2.39.5, git init, git fetch and checkout's temporary HOME/safe.directory. It does NOT show a REST/archive fallback; no such cause is claimed.

Likely boundary: checkout's safe.directory lives in temporary HOME, while later root-container Git uses normal /github/home and a runner-owned mounted workspace. This ownership/config inference is supported by a disposable UID diagnostic, not substituted for the actual new Actions run.

## Narrow workflow repair

- Install declared git/native-addon/hook prerequisites BEFORE checkout in both jobs.
- After checkout, CI-only exact workspace trust: git config --global --add safe.directory "$GITHUB_WORKSPACE"; immediately verify git -C "$GITHUB_WORKSPACE" rev-parse --is-inside-work-tree.
- Keep the final real gate, explicitly targeted: git -C "$GITHUB_WORKSPACE" diff --check. No ||true, wildcard trust or disabled check.
- Remove push event; pull_request creation/reopen/synchronize remains. One workflow per PR push instead of push+PR duplication.
- Preserve Node22.22.3/init/permissions/timeouts/check/test/native behavior. No application/package/type file change. No local-user/global Git config command was executed.

## Static and owned diagnostic evidence

Parsed workflow/order/path assertions prove two jobs, prerequisites<checkout<trust<npm, PR-only event and exact workspace trust/final diff target. Source byte equality against a82ad10 is checked; W3 untracked-file hashes/status preserved.

Disposable --init/--network none container, no mounts/ports/credentials:
- Own temp git repository assigned UID1001 while invoking Git as root with fresh temporary HOME.
- Before scoped trust: git -C <own-workspace> diff --check exits129.
- Add only that exact workspace in this container HOME.
- rev-parse prints true; diff check exits0; safe.directory prints only the owned path.
- Overall diagnostic exit0: /tmp/gol479-git-uid.log; temp files/container removed.

This diagnoses a supported mechanism; actual new-SHA PR run is still required. No redundant local93-test run for workflow-only changes, no old-SHA rerun used as new evidence. Coordinator pushes the new spec SHA once, then records check AND test success plus a single pull_request workflow run. Until that return, remote acceptance is pending.
