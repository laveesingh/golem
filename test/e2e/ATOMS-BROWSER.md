# GOL-501 pinned browser and initial candidates

This is a guarded fixture workflow, not browser or W4 acceptance. `8038855` preserves the first
Mac component/build checkpoint. The guard delta must be frozen at a new clean commit before use.
No browser/image/build/test operations are authorized merely by this document.

## Exact identity

- Image: `mcr.microsoft.com/playwright@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7`.
- Platform: Linux amd64 only. No ARM or mutable-tag fallback.
- Installed Playwright/test and core: 1.63.0. Expected Chromium registry revision1243, version153.0.8010.12.
- These are expectations until runtime. The launcher pulls/inspects actual RepoDigest/OS/arch/config
  ID, binds each CID+nonce to that observed ID, then releases its private execution gate.
- Preparation records actual registry hash, executable path/SHA256 and observed `--version`, Node
  version, source commit/tree/archive hash. CDP browser version and executable hash are rechecked.

## Required explicit facilities and commands

Supply the actual local Unix Docker daemon and absolute Docker executable. Empty owned Docker
config is used; no credential/context/profile copy or daemon restart. Run only under a granted slot.

```bash
PIN=$(git rev-parse HEAD) # must be the reported frozen guard hash, clean status
DOCKER_BIN=/absolute/path/to/docker
DOCKER_HOST=unix:///absolute/path/to/the/approved/local/docker.sock
WORK=$(mktemp -d /private/tmp/gol501-browser.XXXXXX)
node test/integration/atoms-linux-probe.mjs \
  --docker-bin "$DOCKER_BIN" --docker-host "$DOCKER_HOST" \
  --source-commit "$PIN" --mode functional --output "$WORK/functional"
```

The explicit command refuses unclean/wrong source before allocation. Containers are unique,
labelled, `--init`, amd64, same UID/GID, private HOME/npm/temp/results/SWC cache and per-container
shared memory. No published host port or named volume. Preparation alone has public install
network and runs the frozen lock through `npm ci --ignore-scripts`; no shared dependency edits or
implicit browser downloads. Build/browser phases use `--network none` and bundled `/ms-playwright`.

Functional phase uses W2's native `runScript` and the actual fresh Ladle build/owned preview.
It requires exact story IDs, HTML/assets/served nonce, own Chrome/CDP/profile, real authoring axe
panel plus Playwright axe, themes/densities, local7 HTTP byte hashes and correct custom-font Latin
glyph families, native behavior, paired paint and opaque focus states. Its successful receipt is
bound to the exact observed identity before capture is enabled.

## Capture only after functional green, unchanged source, explicit capture grant

```bash
node test/integration/atoms-linux-probe.mjs \
  --docker-bin "$DOCKER_BIN" --docker-host "$DOCKER_HOST" \
  --source-commit "$PIN" --mode capture --output "$WORK/capture"
```

This starts a fresh frozen copy and independently re-proves image/executable and functional green.
Only then does it run `atoms-visual --update-snapshots` with explicit initial-candidate mode and
an absent baseline directory. No code changes during capture. All40 actual panel PNGs are required:
`{button,iconbutton,input,pill,badge}-{light,dark}-{cozy,compact}-{320,640}.png`.
Interactive panel images include keyboard busy-focus or invalid-input focus. Each capture checks
real axe and fonts and records actual panel geometry, viewport, scale and CDP version.

Validation requires exact names/count, owned regular files, complete PNG chunks/checksums/pixel
rows, nonempty actual dimensions matching panel geometry, source/font/image/browser provenance,
and a functional-green fence. Partial/failed capture can retain private failure artifacts but
cannot create a publishable candidate set. Output is `capture/candidates/{40 PNGs,manifest.json}`.
The manifest says **NOT ACCEPTED**. Unit-generated PNGs test guards only and are never visual evidence.

## Only validated new candidates may copy

```bash
node test/integration/atoms-linux-probe.mjs \
  --source-commit "$PIN" --mode copy-candidates --output "$WORK/capture/candidates"
```

Copy requires the unchanged frozen commit and absent `test/e2e/__screenshots__/atoms` destination;
only the validated40 new PNGs and manifest copy. No source/dependency/log/profile/failure files.
The initial candidate commit names the component visual change. It is not baseline acceptance.
Fresh visual review and separate normal comparison on the same pin must precede merge:

```bash
node test/integration/atoms-linux-probe.mjs \
  --docker-bin "$DOCKER_BIN" --docker-host "$DOCKER_HOST" \
  --source-commit "$REVIEWED_CANDIDATE_COMMIT" --mode compare --output "$WORK/comparison"
```

Original capture commit/tree/archive/image/browser/font provenance is never rewritten when candidate
artifacts are committed. Normal comparison proves descendant lineage with only the named artifact
folder changed, byte-identical atoms/stories/workshop/CSS/tokens/fonts/config/dependency lock and
renderer/test/clock/id inputs, and newly observed image/executable/registry/Node identity matching the
original capture. A mixed source or tampered identity fails before comparison.

Normal comparison sets `updateSnapshots: none`; it never fills missing files or updates old images.
It re-proves functional behavior and compares the candidate set with no update flag. Full source
checks, independent verification and coordinator rerun remain separate requirements.

## Cleanup and limits

Declared browser results are bound to the caller's canonical parent device/inode/UID before
Playwright starts. After Playwright cleans its output leaf, globalSetup can recreate that leaf only
under the same parent epoch inside private TMPDIR. Missing environment/identity, changed/symlink/
writable parent or escaped/symlink leaf fails before recreation; no parent fallback is inferred.
Capture records are restricted to the declared results/capture-records leaf.

Each container is stopped/removed only after exact CID+nonce binding. Interrupted/failing/uncertain
operations retain owned artifacts and report failures, not cleanup success. Own Chrome/context/CDP
and preview are bounded and stopped before profile deletion; missing env fails before allocation.
Supplied pinned image is preserved, never globally pruned. Successful output retains identity,
image/binding/stage receipts and candidate manifest; temporary source/deps/config are removed.

The workshop is a named region inside Ladle's existing main landmark. Explicit opacity1/filter-none
resets protect approved paired paint from authoring-host styles; they do not dim/mix token colors.
A real pointer coordinate click checks busy suppression without Playwright's aria-disabled click
preflight being mistaken for component behavior. There is no production shell/island/router/store,
legacy activation, upstream glyph membership, arbitrary-language glyph, or full-W4 claim here.
