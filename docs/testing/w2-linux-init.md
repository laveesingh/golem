# W2 supported Linux reaping prerequisite — GOL-472

This is config/docs-only topology clarification; main/runtime/test code remains reviewed2bd7db1. No main fence is reopened.

## Observed unsupported and supported environments

GOL-472's focused final-command container launch without a reaping parent failed:6failed/10passed, exit1. Orphan groups survived after owned signals because a final shell command can exec Node as PID1, and Node is not the required orphan reaper. The reviewer changed only launch topology to retain bash as PID1;16tests passed. This is evidence of an environmental prerequisite, not arbitrary-entrypoint Linux support.

Original failed output is preserved losslessly as `gol472-linux-faults.log.gz` from `/tmp/gol472-linux-faults.log`; decompression reproduces the exact original bytes/SHA256. Its exit1/6fail result is not discarded. Historical full multi-command launches passed with a shell retained; those results do not certify Node-as-PID1 entrypoints.

Supported Linux verification now requires explicit init:
- Devcontainer: `"init": true`.
- Both Actions jobs: `container.image: node:22.22.3-bookworm`, `container.options: --init`.
- Raw verification: `docker run --rm --init --network none ...`.

No credential/HOME/socket mounts, published ports, named volumes or shared stacks. Dependency provisioning may use network; runtime checks/tests remain network-disabled in Docker.

## Flag contract checked on2026-10-01

- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idcontaineroptions): container.options configures additional docker-create options; explicitly unsupported flags are --network and --entrypoint, not --init.
- [Official runner DockerCommandManager source](https://github.com/actions/runner/blob/main/src/Runner.Worker/Container/DockerCommandManager.cs): DockerCreate forwards `container.ContainerCreateOptions` into dockerOptions before executing docker create. No --init filtering occurs on this path.
- Local `docker create --help` lists `--init Run an init inside the container that forwards signals and reaps processes` (exit0). Actual runtime --init acceptance/reaper identity is verified below.
- [Dev Container metadata reference](https://containers.dev/implementors/json_reference/#general-properties): init boolean defaults false and indicates a tini init process to deal with zombies.

This establishes supported syntax/default runner forwarding and actual local Docker behavior, not a remote GitHub Actions execution pass. Remote Actions/amd64 remains UNRUN until the branch is pushed/executed.

## Reproduction

From the ticket checkout, use this complete **:init BUILD/RUN** chain. `set -e` prevents running a missing/stale image after a failed build:
```bash
set -e
CTX=$(mktemp -d /tmp/gol458-linux-build.XXXXXX)
tar --exclude='node_modules' --exclude='./.git' --exclude='./dashboard/dist' --exclude='./.test-results' -cf - . | (cd "$CTX" && tar -xf -)
docker build -t golem-gol458-ci:init -f "$CTX/.devcontainer/Dockerfile.ci" "$CTX"
rm -rf "$CTX"
docker run --rm --init --network none --name golem-gol458-init-$(date +%s) golem-gol458-ci:init
```

A focused final-command launch with --init can no longer rely on incidental shell retention:
```bash
docker run --rm --init --network none --name golem-gol458-init-focused-$(date +%s) golem-gol458-ci:init bash -lc './node_modules/.bin/vitest run --project integration test/integration/main-ownership.test.mjs test/integration/adapter-safety.test.mjs test/integration/retained-root.test.mjs test/integration/html-mutation-safety.test.mjs test/integration/scratch-fixture.test.mjs'
```

After the full run and any optional focused run above, **REMOVE the same :init tag**:
```bash
docker image rm golem-gol458-ci:init
```

## Actual rebuilt supported environment

- Image rebuild exit0: /tmp/gol458-init-linux-build.log.
- --init Node-as-child PID1 probe exit0: Linux arm64/Node22.22.3, /proc/1/cmdline starts `/sbin/docker-init -- docker-entrypoint.sh node ...` (/tmp/gol458-init-pid1.log). This is actual init, not incidental bash retention.
- Focused final-command shell launch with --init/--network none:exit0,5files/16tests/no skips,9.04s (/tmp/gol458-init-focused.log). Same command topology that failed without a reaper now passes with the explicit prerequisite.
- Full rebuilt --init/--network none run:exit0,11files/93tests/no skips,181.22s; check37Biome files/strict/native0; Knip baseline136/current135/no added with explicitly resolved processGroupProcesses export; native/bin0 and type controls expected2/2/1 then restored0/0 (/tmp/gol458-init-linux-full.log).
- Preserved unsupported failure log SHA256:`c21a65b0972925e90f1668ef5ecde06051fc446568736ac409deb6a9c971e8f8`.

Source/runtime/test code is unchanged from2bd7db1, whose macOS full93/check was independently rerun by the orchestrator. No redundant macOS run was needed for these config/docs-only edits. Remote Actions/amd64 remains UNRUN. W3/W7 artefacts and W4 component/E2E remain pending; this environment requirement does not waive failure/cleanup assertions or excluded/live tests.
