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
- Working source check and full24files/274tests pass; static23negative/24state/
  seven-font checks pass. Final frozen-commit macOS/Linux artefact evidence and
  independent review/verification/coordinator acceptance are still pending.

Early fixture failures were incorrect COLOR_LITERAL expectation (actual code
COLOR) and Darwin /tmp versus /private/tmp Vite root spelling. Corrected fixture
expectation/canonical root, not product error behavior. Initial Knip rejected
an unconsumed output-name export; IO now uses that same canonical list, not a
fake entry/baseline waiver. Formatting failure on unsafe finally was repaired
by preserving original/rollback/cleanup errors rather than throwing over them.

Other installed generators/developer-only manifest scripts, persistence,
JSONL headers, nouns/client/released compatibility and full W7 remain pending.
No authored version bump, main/spec merge, global render/install/live/native
or instruction-content checks belong to this task.
