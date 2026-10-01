# Isolated development profiles (W1)

From a checkout on Node 22.19+:

```sh
node cli/golem-bin.js --profile dev dev
# Choose the fixed block on first creation only:
node cli/bootstrap.ts --profile another --port 23000 dev
node test/profile-isolation.test.mjs
```

`npm link` uses `cli/golem-bin.js`. Bootstrap resolves the **global prefix**
`--profile` before dynamically importing the existing CLI. Command-local model
profile flags (`golem pi --profile model`, `agent create --profile model`) remain
unchanged. Without a global profile the environment and production defaults are
unchanged. Profile `migrate-home` is refused before CLI import (also guarded at
its legacy handler), because that verb intentionally targets production paths.
Profile doctor skips production migration/split-brain diagnostics. Profile restart
retains the existing command/GOLEM_HOME ownership filter and checks the private
port block **after** stopping owned writers; a foreign occupant is never selected.
The inherited restart sweep does not capture/revalidate PID birth immediately
before signaling; W1 does not redesign that management/process boundary.
The CLI sync-check/doctor path no longer performs advisory instruction-size lint
or prints its word-count report/warnings. Render generation and drift checks stay;
W6/W8 must document this visible output removal in the 6.0 release note.
Direct legacy `node cli/golem.js` remains available but does not parse
instance profiles. W3 owns emitting/re-writing this bootstrap graph for packages;
a physical npm installation cannot yet execute its TypeScript import.

## Paths and ports

Each profile owns `~/.golem-profiles/<name>/profile.json`, private native Claude
config/install/sessions, Pi agent config and sessions, Golem registries/DB/renders,
XDG config/data/state/cache/runtime, user skills, projects and ideas. No credentials
are read or copied during creation. Profiles are collision boundaries, not sandboxes.

The manifest persists dashboard N, Vite N+1 and Ladle N+2. The initial default is
a deterministic non-default block; `--port N` chooses it explicitly on creation.
Changing a persisted block is refused. Zero/default ports, invalid names and an
occupied listener anywhere in the block fail before children start. Listener
checks cannot remove the bind race; dashboard and Vite must also refuse occupied
ports. Development launch owns two foreground children, uses a private Vite dependency cache, and stops both on signal
or child failure. It does not start Ladle; the future W4 stories use the profile
port through `dashboard/.ladle/config.mjs` (Ladle execution pending W4).

Bootstrap replaces dirty inherited path/port values. It removes inherited native
session/socket/pane and Golem/Claude/Pi caller identity variables. Native allocated
per-project handles then select their own namespace sockets. The legacy channel
fallback points at an unavailable route on the private dashboard, never live7421.
`CLAUDE_CONFIG_DIR` is resolved by `lib/claude-paths.js` and the shell mirror in
`substrate/hooks/_golem-home.sh`. Both harness render copy lists include the new
runtime helper. CC instruction outputs now use that configured directory directly.

## Native namespace evidence and short aliases

Read-only evidence: installed Homebrew herdr **0.9.1** formula at
`/opt/homebrew/Cellar/herdr/0.9.1/.brew/herdr.rb` pins:

- Source: https://github.com/herdrdev/herdr/archive/refs/tags/v0.9.1.tar.gz
- SHA256: `03403d3ef80dcf2b954dd5d27eb636e6c4f5279d240b48de272b7f53e4b73093`
- `src/config/io.rs:30–41`: `config_dir()` joins `XDG_CONFIG_HOME` with `herdr`;
  `state_dir()` similarly honors `XDG_STATE_HOME`.
- `src/session.rs:160–193`: session directories and API/client socket paths derive
  from `config_dir()`. Explicit `--session` overrides inherited socket selection.
- `src/session.rs:187–212`: inventory enumerates **only** that config namespace's
  `sessions` directory. Changing state paths alone would not isolate adoption.
- `src/ipc.rs:35–64`: Unix connect/bind converts the supplied spelling using
  `GenericFilePath`; these paths are not canonicalized before socket binding.

On macOS the allocated `g-<28 hex>` handle under the full profile path exceeds
`sun_path` (104 bytes including NUL). W1 therefore sets `XDG_CONFIG_HOME` to
`/tmp/gp-<uid>-<16 hex digest of absolute profile root>/c`, an exact symlink to the
canonical profile `xdg/config`. It also sets private `XDG_STATE_HOME`; native
namespaces are disjoint even when handle names happen to match.

The alias owner directory is created exclusively with 0700 permissions. Reuse
checks its type, UID, permissions, absence of unknown entries, and the link's
UID/type/exact target. Unknown entries fail closed; they are not overwritten or
removed. The longest allocated socket suffix (`herdr-client.sock`) must fit in
103 bytes before children start. The alias persists for daily reuse; tests remove
only their exact owned links/directories after both children stop. Adopted native
names longer than allocated handles may hit the native Unix limit; no broad
management-name redesign is included in W1.

## Evidence boundaries

`test/profile-isolation.test.mjs` uses a temporary HOME with fake live sentinels.
It starts two real private dashboards and Vite proxies, creates/archives tickets
through `_scratch.mjs`, checks cross-profile reads/writes, mapping-selected native
child calls against a simulator, dirty environment, model-flag preservation, migration refusal, foreign-owner
restart rejection, alias tampering, actual Node
Unix socket binding, private CC sync and native/skills path consumers. It observes
zero fake-live writes and checks both owned listener blocks close while stopping
one retains the other. It never watches the user's real private paths.

The herdr simulator follows the source above; it is **not native acceptance**.
Actual herdr server/harness launch and adoption remain prohibited/pending overnight.
The rendered helper import checks exercise W1's changed copy lists, not full
standalone MCP tool execution or Pi loader acceptance.
Installed emitted tarball and standalone rendered-helper acceptance remain W3/W7
work. Ladle process acceptance awaits W4. No version bump, main merge, live dashboard
restart, plugin reinstall or shared render sync belongs to these checks.
