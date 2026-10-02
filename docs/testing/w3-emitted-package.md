# W3 emitted package checkpoint — incomplete W3

## Implemented boundary

- One committed JavaScript bin selects native bootstrap.ts only outside real node_modules paths; otherwise selects dist/cli/bootstrap.js. A stray installed TS file cannot become a fallback. Clean checkout/link needs no dist.
- prepack runs strict checking, tsc mirrored JS/maps emission and the real Vite dashboard build. dist is uncommitted. The tarball ships the bin, emitted runtime, contract JSON, substrate, web assets and MCP manifests. Raw backend cli/lib/server sources are excluded.
- The installed CLI checks module resolution, not a package-local node_modules directory: npm hoists root dependencies into the prefix. Dashboard process discovery/start uses caller-based packageRoot/runtimeFile rather than the emitted module's directory.
- postinstall installs the MCP child beside its executable: source mcp/channel in a checkout, dist/mcp/channel in the tarball. Private CC generation copies that exact dependency graph. This is not W7's bundled child or Pi-loader acceptance.
- The installed probe uses an actual physical npm installation, empty cwd, allowlisted private state/environment, quarantined scratch cleanup, an owned detached group and incarnation-fenced cleanup. It exercises CLI, a named-profile dashboard, actual health/create/body400, templates/web asset URLs, role cards, private CC generation, inherited wrong roots, render-parent/installed-child help, SDK resolution beside dist and absence of a development compiler.

## Recovery rerun — 2026-10-02

The successor compared `git status --short` against the preserved recycle status before testing: all 17 entries matched (diff exit0), HEAD `ad70055ccf9b5c7916a51aff27211b1d5a75d80d`. No reset, restoration or source edits occurred. The coordinator granted one exclusive test slot after lane A released it.

Environment: Darwin arm64, Node `v22.22.3`, npm `10.9.8`, existing CoW worktree dependencies. Installation used an owned HOME and prefix; the probe used its allowlisted private sandbox environment, empty cwd and ephemeral non-7420/7421 port. No user credentials/state or global npm prefix was used.

Before any edits, the successor ran:

```sh
ROOT=/private/tmp/gol477-b4-package.pIwTDC # created with mktemp -d
npm pack --pack-destination "$ROOT"
HOME="$ROOT/home" npm install --prefix "$ROOT/prefix" --omit=dev --no-audit --no-fund "$ROOT/laveesingh-golem-5.26.0.tgz"
node test/fixtures/w3-installed-probe.mjs "$ROOT/prefix/node_modules/@laveesingh/golem"
```

All three commands exited0. Logs: `/tmp/gol477-b4-recovery-{pack,install,probe}.log`. Actual probe output:

```text
INSTALLED PACKAGE PASS: CLI/profile/dashboard/body400/roles/templates/web/private CC generation/dist deps/render parent child; no dev compiler
```

Post-run status still matched all17 preserved entries; `git diff --check` exited0. The probe archived scratch tickets, stopped its owned process group and removed its sandbox/profile alias. The separate owned installation prefix/archive remains at ROOT for evidence inspection. The slot was released at this boundary before this document edit. No new full-source or clean-link rerun is claimed; those results below belong to the predecessor. `test -S ~/.docker/run/docker.sock` returned1; final Linux remains pending and Docker was not restarted. This recovery proves the preserved macOS package slice, not full W3 acceptance or independent verification.

## Predecessor macOS commands and results

From `.worktrees/GOL-477-contracts-artefacts`:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.emit.json --pretty false
npm pack --pack-destination /tmp
HOME="$ROOT/home" npm install --prefix "$ROOT/prefix" --omit=dev --no-audit --no-fund /tmp/laveesingh-golem-5.26.0.tgz
node test/fixtures/w3-installed-probe.mjs "$ROOT/prefix/node_modules/@laveesingh/golem"
npm run check
npm test
```

- Emit/pack/physical install/probe exit0. Installed graph proof: `INSTALLED PACKAGE PASS: CLI/profile/dashboard/body400/roles/templates/web/private CC generation/dist deps/render parent child; no dev compiler` (`/tmp/gol477-b2-pack-final.log`, `install-final.log`, `probe-graph.log`). The disposable ROOT is recorded in `/tmp/gol477-b2-install-root`.
- Final source check0 and unfiltered **16 files / 101 tests / no skips**,217.73s (`/tmp/gol477-b2-final-check.log`, `final-macfull.log`). Existing explicit UNVERIFIED_INITIAL_BOOTSTRAP is not released-schema compatibility acceptance.
- Actual owned clean-link smoke: archive ad70055 into ROOT/checkout, overlay current bin/manifest, CoW-copy verified source dependencies, assert dist absent; `HOME="$ROOT/home" npm_config_prefix="$ROOT/linkprefix" npm link --ignore-scripts --no-audit --no-fund`; run ROOT/linkprefix/bin/golem --help from ROOT/empty. Both exit0; no global/user prefix modified (`/tmp/gol477-b2-link2.log`, `link-help.log`). This proves native launcher/link, not all checkout source commands.
- Automated launcher negative included in 101: clean native source works; installed missing dist fails2 despite stray bootstrap.ts; installed JS works with stray TS still present. No native TS fallback error occurred.

## Failures that changed the implementation or checks

- First real installed dashboard exited1: `root deps missing — npm install (from the repo root)`. npm's dependencies were hoisted. Replaced directory checks with actual dependency resolution.
- Parent root assertion initially compared `/tmp` against Darwin's canonical `/private/tmp`; fixed the fixture expectation, not package-root semantics.
- `npm link --global` refused `ELINKGLOBAL`; followed npm's supported unflagged link with npm_config_prefix owned by the fixture.
- Knip initially rejected the standalone installed probe as a new unused file. Added exactly that real manual entry; no baseline regeneration.
- Final graph correction moved installed MCP dependency installation beside dist/mcp/channel. The final probe additionally proves SDK resolution there and no TypeScript compiler in that resolver graph.

## Linux evidence and interruption

- Before the final MCP postinstall correction, rebuilt supported `docker run --rm --init --network none golem-gol477-ci:b2-package` passed check/full101/native/type negatives,189.62s (`/tmp/gol477-b2-linuxbuild.log`, `linuxfull.log`). A separate physical tarball installation/probe passed under --init/network none (`linuxartefact5.log`). Dependency metadata/tarballs were provisioned during the owned image build, then node_modules removed and npm ci repeated offline at runtime.
- Initial offline install failed ENOTCACHED on missing registry metadata; package-lock-only provisioning then failed on an absent prefix directory; after creating it, offline install exposed an uncached newer ws tarball. Provisioned the exact lock's packages during image build before the successful offline runtime. None of these failures was reported as acceptance.
- FINAL Linux image rebuilt with the corrected postinstall/probe, but final full run exited125 near its end: `error waiting for container: unexpected EOF`. Docker API socket then disappeared. No final suite summary, no final native/type tail, and no final installed artefact proof. Did not restart shared Docker. Logs: `/tmp/gol477-b2-final-linuxbuild.log`, `final-linuxfull.log`. Earlier Linux passes do not certify the final package.

## Remaining W3 acceptance

- Final supported-init Linux full/native/type and physical installed graph after Docker availability; repeat clean-link on frozen complete source; repeatable release/artefact job wiring and broader failure checks.
- Installed tools/generator entry and default-root/development dependency closure: tools source/config assumptions remain; this checkpoint does not certify installed npm generator scripts. Token materialization awaits accepted A source, not its active uncommitted worktree. Pin/hash/freshness-check one generation, stage regular entry/generated/font files, prove archive/install/Vite/font-byte equivalence; never mutate source pointer or trust npm-preserved symlinks.
- readVersioned, all three unversioned stores and every consumer, JSONL headers/readers/writers/zero-write/future-version refusal, source-grounded noun projections/shared Node client, released-contract/deprecation compatibility remain incomplete. You/StatusLine/unified InboxItem remain pending product decisions.
- W7 full bundled-child/Pi-loader/standalone-render matrix, W4 UI, W5 clock/recorders, W6 removals and W8 CLI envelopes are separate. No version/publication/main/global render/live server/harness changes. Full W3 requires untouched review plus separate verification before a serialized spec merge slot.
