# W3 asset-root source slice — not installed-package acceptance

After pilotdf01651, package-root.ts owns calling-module root lookup: nearest named Golem package.json or validated .golem-render.json, never inherited GOLEM_ROOT as an asset root. roleAssetsRoot distinguishes package substrate/roles from render roles. runtimeFile selects actual source or existing emitted mirror and fails on absence.

Repaired source consumer boundaries: bootstrap checkout metadata, CLI version/server paths, dev server path, dashboard web/templates/substrate metadata, packaged role-card discovery and MCP hook discovery. Existing explicit unprofiled GOLEM_SUBSTRATE_ROOT/GOLEM_ROLES_DIR overrides remain; named profiles clear inherited asset selectors and derive own package assets, avoiding auto source-root variables leaking into descendants. GOLEM_ROOT retains its existing workspace-anchor purpose, not asset lookup authority.

CC/Pi private render plans now carry marker/schema JSON and repair the affected dependency-free helper graph: source-checkout TS/helper .ts imports emitted to JS; installed layout prefers already emitted JS without a development compiler import. This does not bundle MCP/remove node_modules (W7), and no installed tarball has been tested yet. Source runtime emit uses existing development TypeScript only when necessary; copied helpers import no package.

Actual evidence:
- Strict source check0/new package-root owned test1pass: independent fake installed/render callers with bogus inherited root, separate role roots, runtime mirror lookup, invalid marker/missing runtime errors.
- Focused actual profile/Pi-CLI/MCP consumers0:4cases (selector-skipped others, not full acceptance), /tmp/gol477-asset-render-targeted.log.
- npm run check0, full unfiltered macOS15files/100tests/no skips0,217.03s: /tmp/gol477-assets-profile-check.log,/tmp/gol477-assets-source-full.log.
- Rebuilt Linux --init/--network none complete CMD check/full/native/mutations0,15files/100tests/no skips,189.12s: /tmp/gol477-linux-assets-build.log,/tmp/gol477-linux-assets-full.log.
- No real harness/global sync/installed plugin/live server/main/version/publication changes.

Remaining gates: committed JS launcher reconciliation/prepack mirrored emission/physical installed tarball+cleanlink and actual distinct render-parent/installed-child consumers, emitted root dependency closure, versioned stores/JSONL/all readers-writers, complete implemented noun/sharedNodeclient contracts, actual released-schema compatibility, full W3 artefact/failure evidence. Fake package-root fixture is explicitly not an installed artefact pass. W7 standalone fullbundle/Piloader, W8/W6/W4/W5 remain separate.
