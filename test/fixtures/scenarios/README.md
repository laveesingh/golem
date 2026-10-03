# S4 recorded scenarios — provenance

All three fixtures below are real runs on Golem profile `rec`
(`~/.golem-profiles/rec`), recorded 2026-10-03 through the run-owned broker
(`lib/scenario-recorder.ts`: ordering + `scrubScenario` validation on close),
then copied verbatim to this directory. Each passes
`node tools/scenario-scrub.ts --check` (canonical scrubbed data).
`golem_version` 5.26.1 is the working tree version, not a release claim.

| Fixture | What ran | Provenance |
|---|---|---|
| `typed-brief-accepted-settled.json` | Real `pi` 0.99.1 (`--provider opencode-go --model muse-spark-1.3-contributor:xhigh`, enforced in the recording extension: any other model writes `failed` and aborts) with a real `PiNativeAdapter` endpoint; one `/brief` POST accepted on arrival and settled after the model replied `RECORDING_OK`. 5 events. | `tools/record-scenarios.ts` with `GOLEM_RECORD_REAL=1` |
| `claude-dispatch-ack-return.json` | Real `claude` 2.1.288 with `--model claude-haiku-4-5` (settings pin `haiku`-only; the run's init log shows `claude-haiku-4-5-20251001`) in a herdr pane (a real pty) with the real channel server; a dashboard `/api/brief` to the discovered channel session is pushed over the channel; the agent calls `ack` (production seam records the acknowledged return) and posts `RECORDING_RETURN` on the run-isolated scratch ticket (production seam records the returned comment). 4 events. | `tools/record-claude-scenario.ts` with `GOLEM_RECORD_REAL=1` |
| `herdr-worker-lifecycle.json` | Real `herdr` 0.9.1 server under the rec `XDG_CONFIG_HOME`: `workspace create`, `tab create`, `agent list` (empty roster — no agent had started), driver `paneRun` (`echo RECORDING_OK`), second `agent list`, `pane close`, `session stop`. 18 events; stdout payloads are real server envelopes with ids symbolized and labels redacted by the scrubber. | `tools/record-herdr-scenario.ts` with `GOLEM_RECORD_REAL=1` |
| `dashboard-restart-stranded-envelope.json` | Real dashboard on rec port 19929: brief to an offline session strands queue rows (HTTP 502, envelope stays `pending`); dashboard `SIGKILL`ed; envelope verified still `pending` after restart; a live brief to a real Pi typed session through the restarted drainer is accepted and settled. 6 events (`$envelope:1` stranded lineage, `$envelope:2` live lineage). | `tools/record-restart-scenario.ts` with `GOLEM_RECORD_REAL=1` |

Ack linkage note: channel notifications carry the envelope id in message
meta, which the model cannot see (it asked for the id and was refused by the
brief text). So the recorded ack carries no envelope id and the comment is a
bare `RECORDING_RETURN`. The linkage is run isolation: the ticket is created
in-run, the agent is the only writer, and the ack/comment land inside a
minute-scale window after the brief to the discovered session. The dashboard
view corroborates (`accepted: true`, comment present). No other harness or
model was used for any fixture.

macOS note: the Claude child keeps the real user HOME so Keychain login
resolves, while `CLAUDE_CONFIG_DIR` pins rec state; the pane needs a trusted
cwd (the main checkout) and answers the dev-channel list with option 1.

Scrub note: the recorder extends the provisional argv/scrub grammar only from
these accepted recordings (herdr envelope keys, `terminal_id`, dashboard
replay states); see `tools/scenario-scrub-core.ts`. No credential, prompt,
transcript, or raw payload bytes are retained anywhere in these files.
