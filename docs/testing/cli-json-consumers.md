# CLI JSON consumers (S2 envelope)

Every `golem ... --json` form emits one flat envelope (`lib/cli-envelope.ts`):

- success: `{ schema_version, ok: true, ...fields }`
- failure: `{ schema_version, ok: false, error: { code, message, details? } }`

Arrays travel as `items`. Management lists stay `schema_version: 2`;
all other families start at 1. Exit codes are unchanged
(0 ok, 1 operational, 2 input, plus 3 uncertain for notify flows).

Rule: check `ok` before reading fields. Never parse a raw array
or assume `ok` is present without reading it. JSON intent is detected
from raw argv before any parsing or validation (`wantsJson`), so parse
and validation errors also emit the error envelope with unchanged exits.

## Readers

| Reader | What it reads | Status |
|---|---|---|
| `test/_management-list.mjs` (+ `agent-cli`, `team-journey`, `session-cli`, `worker-journey`, `management-resolve`, `team-registry`, `model-profiles` tests) | management `list --json` receipts | parses via `test/_cli-envelope.mjs`, asserts `ok:true`, `schema_version:2`, `items` array |
| `test/notification-cli.test.mjs` | schedule/message/notify `--json` | parses via `test/_cli-envelope.mjs`; schedule lists read `.items` |
| `test/ticket-cli.test.mjs`, `test/gol346-acceptance.test.mjs`, `test/gol369-integration.mjs` | ticket `--json` | parses via `test/_cli-envelope.mjs`; grandchild asserts `ok:true` + `items` array |
| `test/session-cli`, `scoped-stop`, `team-retained-pane`, `session-native`, `management-consumers`, `worker-journey`, `profile-isolation`, `release-smoke`, `management-real-journey` tests | per-family `--json` | parses via `test/_cli-envelope.mjs`; error assertions read `error.message` |
| `test/unit/cli-envelope.test.mjs` | all eight `Cli*Result` contracts | one success + one error shape per family, against `contracts/dist/Cli*.schema.json` |
| `test/fixtures/cli-envelope-probe.mjs` (via `test/integration/cli-envelope.test.mjs`) | all eight families, live invocations | success + error per family, plus arrays/help/status |
| `substrate/skills/team-ops/SKILL.md` | instruction examples (`golem context --json`, verb `--json`) | documents the envelope rule where agents read CLI JSON |
| `substrate/skills/staying-awake/SKILL.md` | single example (`agent notify ... --json`) | example only; never parses output — no change needed |
| dashboard server, `dashboard/scripts`, `scripts`, Pi shim (`shims/pi/golem.ts`) | — | no reader of Golem CLI JSON found (dashboard `native-sessions` and sim probes read the external `claude`/`herdr` CLIs, not `golem --json`) |

No reader parses a raw array or ignores `ok`.
