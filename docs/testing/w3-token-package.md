# W3 actual token package — bounded checkpoint

## Contract

Native token CLIs derive their default source tree from caller `packageRoot()`.
Emitted callers under `dist/` derive the logical style view at `dist/assets/`.
Explicit absolute `--root` remains the exact supplied tree, never cwd or an
inherited GOLEM_ROOT/GOLEM_RENDER_ROOT selector. No new public command is added.

The package view mirrors `dashboard/web/src/ui/{tokens,fonts}` and owns its lint
scope and explicit confined CSS-import closure. The four outputs are ordinary
files at `tokens/generated/`. No source generation directory/pointer is copied
into this view. Input/source/provenance/contrast/entry and seven WOFF2 files,
two OFL licences and font inventory/CSS are included. Legacy theme activation
is unchanged.

`token-package.json` schema_version1 explicitly declares regular layout, the
original generation id, and SHA256 hashes of outputs and fixed input paths.
Regular files/directories are no-follow/confined/bounded and not group/other
writable. Read-only installed files may be owned by the installer rather than
the caller. The marker is not a source-ownership pointer. Unknown versions fail
PACKAGED_VERSION; malformed/hashes/contents/paths fail with named errors.
Entry imports must preserve the two declared relative token/font paths; the
seven local font faces must match inventory family/weight/file tuples.

Packaged `--check` and new-directory `--materialize` are supported.
`--write` fails PACKAGED_READ_ONLY before writes, including malformed package
markers. Explicit owned source roots retain the immutable generation/pointer
publication protocol. Grammar errors exit2; validation/IO failures exit1.

## Build and failure safety

Prepack captures the source pointer once, verifies the snapshot, stages regular
copies, revalidates copied inputs/outputs, emits JS/maps and stages web/MCP
outputs. The source pointer/output bytes are never mutated by packaging.
A source-local exclusive lock serializes publication. Runtime and web trees
are replaced only after all staging/build validation, with inode/device fences
and rollback of previous good trees. This is not one OS-atomic multi-directory
switch. Indeterminate timeout/signal/rollback/cleanup retains stage+lock evidence;
no guessed deletion or stale-owner reclamation is attempted.

Babel parser7.29.9 is an explicit runtime dependency (not a leaked dev tool).
Its types7.29.8/integrity is transitive lock-owned. This intentionally aligns the
approved Ladle resolver choice; no other baseline package version is upgraded.
TypeScript/Vitest remain test/build tools, not installed token CLI dependencies.

## Evidence status

- Source strict and 24 targeted package/publication unit assertions pass. Unit
  compiler mocks prove transaction boundaries, not installed-package acceptance.
- Actual Golem working-source pack/install/token probe passes CLI default and
  explicit roots, regular bytes/font equality, read-only/error controls, counted
  lint escapes, Babel resolution/no dev compiler, and byte-equal source/installed
  Vite CSS plus seven HTTP-served font hashes. It is not a fixture package.
- Actual Golem prepack negatives preserve prior runtime/web/tarball on tampered,
  missing or escaping inputs. An owned pointer-change injection confirms one
  source capture; the private source fixture is restored afterwards.
- Frozen source c27f8a9 check/full24files/274tests/no skips pass on macOS and
  supported offline-init Linux. Static23negative/24state/seven-font checks pass.
  Independent review/verification/coordinator acceptance remains pending.

Early fixture failures were incorrect COLOR_LITERAL expectation (actual code
COLOR) and Darwin /tmp versus /private/tmp Vite root spelling. Corrected fixture
expectation/canonical root, not product error behavior. Initial Knip rejected
an unconsumed output-name export; IO now uses that same canonical list, not a
fake entry/baseline waiver. Formatting failure on unsafe finally was repaired
by preserving original/rollback/cleanup errors rather than throwing over them.

## Frozen artefact evidence

Runtime/source commit `c27f8a9d09446ce3c94474cd5a7dc97f5a221739` was tested;
subsequent evidence-document changes do not alter shipped runtime/assets.

MacOS Darwin arm64 / Node22.22.3 / npm10.9.8: source check0, strict/native21,
Knip baseline137/current134/no additions (not zero debt), 10 Biome infos.
Unfiltered24files/274tests0,216.20s; static0. Actual git-archived Golem source
with exact CoW dependencies, env-i private HOME/TMPDIR/state/cache/prefix:
`npm pack`, `npm install --omit=dev --prefer-offline`, installed token probe,
existing installed package probe, actual prepack negatives all0. Actual archive
has27 regular asset files, four ordinary generated outputs and no source
pointer/generation links in the staged asset view. Logs:
`/tmp/gol500-frozen-mac-{pack,install,token,existing,negative}.log` and
`/tmp/gol500-working-{check2,full,static}.log`.

Supported Linux uses fresh source copied into a NEW writable upper-layer
owned directory for BOTH image provisioning and runtime. Source is unchanged;
provisioned install/prefix is removed before runtime. Runtime uses
`docker run --rm --init --network none`, Node22.22.3/npm10.9.8/aarch64;
PID1/docker-init asserted. Fresh offline npm-ci/check/full24files274tests0
194.53s/native21/type-error controls/static0, NEW offline actual pack/install,
token/existing probes/actual failing-pack preservation/pointer race0, private
clean-no-dist npm-link/help0.61 saved receipt roots/main PIDs absent; tracked
source bytes/pointer unchanged. Actual Vite CSS and seven HTTP font hashes
match source versus installed regular assets on both platforms.

Both final tarballs SHA256:
`be775c833c279f3e28046d0cb38d7c78a528aeafc20352ce2b92ac840a82829d`.
Linux image `sha256:8837b57bc452c29fbee50af6c91529ef3a4a9d3c445f1432394304fe38710983`
was owned/task/session/source-labelled and removed after checks; --rm containers
absent. Inert provisioning scripts `/tmp/gol500-Dockerfile.upper` and
`/tmp/gol500-linux-runtime.sh`, logs `/tmp/gol500-linux-upper-{build,final}.log`
are retained. All owned source/install/link/context/HOME roots were removed
only after an empty survivor scan. Exact image inspect then fails/absence.
Only a copied public npm package cache is retained for a fresh verifier at
`/private/tmp/gol500-owned-cache.s3rrkA/npm-cache`, not a reusable installed prefix.
Exclusive runtime slot was released before this documentation reconciliation.

Retained failure limits: immutable Docker COPY lower-layer directory publication
failed EXDEV during provisioning; coordinator chose fresh writable archive
sources, not a portable-copy product fallback. Publisher supports this writable
topology and still fails closed on unsupported rename topology. First supported
full run failed the unchanged wall-clock typed retry at newer-comment wait;
selected Vitest adapter diagnostic passed1/49filtered skips, then a fresh
unfiltered274 passed. Cause remains unknown; no source fix or timeout weakening.
Logs `/tmp/gol500-linux-build.log`, `...-upper-full.log`,
`...-retry-diagnostic.log` retain all failures; diagnostic skips are not full
acceptance. Safety-test fault receipts intentionally contain indeterminate
cleanup errors; their exact recovery/root absence is asserted, not hidden as
ordinary successful cleanup.

Other installed generators/developer-only manifest scripts, persistence,
JSONL headers, nouns/client/released compatibility and full W7 remain pending.
No authored version bump, main/spec merge, global render/install/live/native
or instruction-content checks belong to this task.
