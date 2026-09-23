// GOL-325: prove the instruction artifacts reaching both harness renders and the
// real template/promotion APIs. Literal contracts guard shipped text; they do not
// claim model compliance. Bounded native-model probes are separate evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import matter from 'gray-matter';
import { lintSubstrate, lintFiles } from '../lib/compiler/lint.js';
import { createScratchTicket, promoteScratchIdea, archiveTicket, SMOKE_PROJECT } from '../dashboard/scripts/_scratch.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repo, 'substrate');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-instruction-workflow-'));
const home = path.join(temp, 'home');
const state = path.join(temp, 'state');
const env = {
  PATH: process.env.PATH, HOME: home, TMPDIR: temp,
  XDG_CONFIG_HOME: path.join(home, '.config'), GOLEM_HOME: state,
  GOLEM_TRACKER_DB: path.join(state, 'tracker.db'),
  GOLEM_PROJECTS_ROOT: path.join(temp, 'projects'), GOLEM_IDEAS_ROOT: path.join(temp, 'ideas'),
  GOLEM_ROOT: repo, HOST: '127.0.0.1', LOG_LEVEL: 'error',
};
const read = (p) => fs.readFileSync(p, 'utf8');
const ticks = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cli = (args) => execFileSync(process.execPath, [path.join(repo, 'cli/golem.js'), ...args], {
  cwd: repo, env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
});
const tickets = [];
let child, base, ideaId, stderr = '';
const previousApi = process.env.GOLEM_SMOKE_API;

// GOL-366 addendum 2 item 9: the human rewrote spec-writing's text, so this
// contract is COLLECTED, not thrown — every failing assertion is reported in
// full at the end and the rest of the journey still runs. The assertions
// themselves are unchanged: they describe the design-boundary contract the
// skill must carry; only the human can edit that text.
function collectAuthoringContract(text, failures) {
  const checks = [
    ['Start design only after my go-ahead', /Start design only after my go-ahead/],
    ['scope/requirements', /scope\/requirements/],
    ['design.*decisions (case-insensitive)', /design.*decisions/i],
    ['not a second decision record', /not a second decision record/],
    ['An explicit request to draft design is that go-ahead', /An explicit request to draft design is that go-ahead|an explicit request to draft design is that go-ahead/],
    ['No diagram or subsection quotas', /No diagram\s+or subsection quotas/],
    ['golem:spec-driven-development owns the work sequence', /`golem:spec-driven-development` owns\s+the work sequence/],
  ];
  for (const [label, re] of checks) {
    if (!re.test(text)) failures.push(`authoringContract: /${re.source}/ did not match skills/spec-writing/SKILL.md`);
  }
}

// R5/D1 authority boundary: the SDD route exists for explicitly authorized
// coordinators; skill access and assignee metadata grant nothing. A test that
// would also accept deleting the boundary proves nothing, so the caller
// mutates the text and expects this to throw.
// GOL-347: spec-writing owns initialize -> outline/read -> targeted patch ->
// rare rewrite, and the persisted ids are never retyped. A test that would
// also accept routine full rewrites proves nothing.
// GOL-366 addendum 2 item 9: also collected — the human's rewrite dropped these
// phrases too. Same reporting path as the authoring contract.
function collectHtmlWorkflowContract(writing, failures, label = 'source') {
  const flat = writing.replace(/\s+/g, ' ');
  const checks = [
    ['Initialize with `golem ticket create --body-format html`', /Initialize with `golem ticket create --body-format html`/],
    ['orient with `get-outline`', /orient with `get-outline`/],
    ['`patch-blocks` against the returned revision', /`patch-blocks` against the returned revision/],
    ['reserve `replace-body` for the rewrite exception', /reserve `replace-body` for the rewrite exception/],
    ["Never retype the server's stable block ids", /Never retype the server's stable block ids/],
  ];
  for (const [label2, re] of checks) {
    if (!re.test(flat)) failures.push(`htmlWorkflowContract (${label}): /${re.source}/ did not match skills/spec-writing/SKILL.md`);
  }
}

function authorityContract(rules) {
  const flat = rules.replace(/\s+/g, ' ');
  assert.match(flat, /Lead normally coordinates spec work/);
  assert.match(flat, /explicitly authorize another role to coordinate a named spec/);
  assert.match(flat, /It keeps its role/);
  assert.match(flat, /`golem:spec-driven-development` within that authorization/);
  assert.match(flat, /loading a skill, reading a spec, assignee metadata, or worker\/review work grants none/);
  assert.doesNotMatch(flat, /assigned lead or a spec/);
}

async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + route, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${await (!response.ok ? response.text() : Promise.resolve(''))}`);
  return response.json();
}

try {
  for (const dir of [home, state, env.GOLEM_PROJECTS_ROOT, env.GOLEM_IDEAS_ROOT]) fs.mkdirSync(dir, { recursive: true });
  const lint = lintSubstrate({ substrateRoot: source });
  assert.equal(lint.clean, true, JSON.stringify(lint.findings));
  for (const file of lintFiles(source)) {
    assert.doesNotMatch(read(file), /Heavy research and grounding go to|surveys to a builder|task→feature/);
  }
  const contentFailures = [];
  const writing = read(path.join(source, 'skills/spec-writing/SKILL.md'));
  collectAuthoringContract(writing, contentFailures);
  // The reusable SDD method is its own discoverable skill with an authorization-
  // aware trigger; a test that also passes without it proves nothing.
  const sddPath = path.join(source, 'skills/spec-driven-development/SKILL.md');
  const sdd = read(sddPath);
  assert.equal(matter(sdd).data.name, 'spec-driven-development');
  assert.match(matter(sdd).data.description, /authorizes you to coordinate a named spec/);
  assert.match(matter(sdd).data.description, /Skill access or ordinary assignment alone is not authorization/);
  assert.match(sdd, /## Ground before commitment/);
  assert.match(sdd, /Design starts only after my go-ahead/);
  assert.match(sdd, /one independent spec review/);
  assert.match(sdd, /independent\n   verification by another session/);
  assert.match(sdd, /Size supporting docs by explanation and ownership, not counts/);
  authorityContract(read(path.join(source, 'instructions/AGENTS.md')));
  assert.throws(() => authorityContract(read(path.join(source, 'instructions/AGENTS.md'))
    .replace('golem:spec-driven-development` within that authorization', 'golem:spec-writing` within that authorization')),
    'removing the SDD route from the authority rule must fail the contract');
  assert.throws(() => authorityContract(read(path.join(source, 'instructions/AGENTS.md'))
    .replace('grants none', 'grants coordination authority')),
    'removing the no-authority boundary must fail the contract');
  // Ownership moved to the shared method: the old lead-only prerequisites and
  // duplicated sequence must be gone, not merely copied elsewhere.
  const leadMethod = read(path.join(source, 'skills/lead/SKILL.md'));
  assert.match(leadMethod, /golem:spec-driven-development/);
  assert.doesNotMatch(leadMethod, /when assigned lead or a spec/);
  assert.doesNotMatch(leadMethod, /Decompose into one task normally/);
  assert.doesNotMatch(read(path.join(source, 'skills/tracker/SKILL.md')), /Decomposition belongs to `golem:lead`/);
  assert.match(read(path.join(source, 'skills/tracker/SKILL.md')), /Decomposition belongs to the authorized coordinator/);
  assert.doesNotMatch(writing, /golem:lead owns the work sequence/);
  // Active guidance must not prescribe the compatibility-only discovery tool;
  // this bans the prescription, not the valid compatibility implementation or
  // the session_notify envelope vocabulary.
  assert.doesNotMatch(read(path.join(source, 'skills/tracker/SKILL.md')), /sessions_dispatchable/);
  // GOL-347: the universal HTML-tag ban is removed and the format split is in;
  // a test that would also accept the old ban proves nothing.
  const sourceTracker = read(path.join(source, 'skills/tracker/SKILL.md'));
  assert.doesNotMatch(sourceTracker, /Never start a body with an HTML tag/);
  assert.match(sourceTracker, /Markdown body starting with an HTML tag is usually a mistake/);
  collectHtmlWorkflowContract(writing, contentFailures);
  assert.match(read(path.join(source, 'skills/spec-driven-development/SKILL.md')),
    /exact `golem ticket` block commands/, 'SDD carries the block commands into tasks');
  assert.doesNotMatch(writing, /golem:lead owns the work sequence/);
  // GOL-366 addendum 2 item 9: report every human-content assertion failure
  // verbatim, after the rest of the journey has run. The suite exits non-zero
  // exactly on these; nothing else may fail because of them.
  if (contentFailures.length) {
    console.error(`ITEM-9 CONTENT ASSERTION FAILURES (human's spec-writing text — not edited by the builder):`);
    for (const failure of contentFailures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    // The negative control is only meaningful while the text satisfies the contract.
    assert.throws(() => collectAuthoringContract(writing.replace('Start design only after my go-ahead', 'Start design immediately'), []).length === 0);
  }
  console.log(`source contracts passed: ${lint.total} words; negative control rejected`);

  for (const target of ['cc', 'pi']) {
    cli(['sync', '--target', target]);
    cli(['sync', '--target', target, '--check']);
    const render = path.join(state, 'renders', target === 'cc' ? 'cc-plugin' : 'pi');
    const renderedWriting = read(path.join(render, 'skills/spec-writing/SKILL.md'));
    assert.equal(matter(renderedWriting).data.name, 'spec-writing');
    authoringContract(renderedWriting);
    const renderedSdd = matter(read(path.join(render, 'skills/spec-driven-development/SKILL.md')));
    assert.equal(renderedSdd.data.name, 'spec-driven-development', 'the shared SDD skill reaches the isolated render');
    const rules = read(target === 'cc' ? path.join(home, '.claude/CLAUDE.md') : path.join(render, 'instructions/AGENTS.md'));
    authorityContract(rules);
    assert.equal(read(path.join(render, 'skills/tracker/templates/spec.md')), read(path.join(source, 'skills/tracker/templates/spec.md')));
    assert.equal(read(path.join(render, 'skills/tracker/templates/task.md')), read(path.join(source, 'skills/tracker/templates/task.md')), 'task template parity, not spec-template only');
    assert.equal(read(path.join(render, 'skills/tracker/templates/spec-html.html')), read(path.join(source, 'skills/tracker/templates/spec-html.html')), 'html spec template reaches the render with format metadata');
    const renderedWritingFull = read(path.join(render, 'skills/spec-writing/SKILL.md'));
    collectHtmlWorkflowContract(renderedWritingFull, contentFailures, 'rendered');
    assert.doesNotMatch(renderedWritingFull, /Current tools replace whole bodies/,
      'the old unconditional whole-body rule is gone from spec-writing');
    assert.doesNotMatch(renderedWritingFull, /do not invent block-edit operations/,
      'patch-blocks is the sanctioned block operation; the old blanket ban is gone');
    for (const skill of ['lead', 'tracker']) {
      assert.match(read(path.join(render, `skills/${skill}/SKILL.md`)), /golem:spec-writing/);
    }
    const renderedTracker = read(path.join(render, 'skills/tracker/SKILL.md'));
    // GOL-347: the universal HTML-tag ban is gone; guidance is format-split and
    // tracker is the canonical golem ticket CLI reference.
    assert.doesNotMatch(renderedTracker, /Never start a body with an HTML tag/,
      'the universal tag-leading ban must not survive (html spec bodies start with tags)');
    assert.match(renderedTracker, /Format is explicit data/, 'format ownership is explicit');
    assert.match(renderedTracker, /Markdown body starting with an HTML tag is usually a mistake/,
      'the tag-leading warning is scoped to Markdown bodies');
    assert.match(renderedTracker, /golem ticket --help/, 'tracker is the canonical ticket CLI reference');
    assert.match(renderedTracker, /--body-format html/, 'html format creation is documented');
    assert.match(renderedTracker, /spec-only/, 'html format is spec-only in guidance');
    assert.match(renderedTracker, /full-body path/,
      'the compatibility limit (markdown full-body vs html expected_revision) is preserved in the tools intro');
    assert.match(renderedTracker, /golem:spec-writing` § HTML spec bodies/,
      'the html editing workflow lives in spec-writing; tracker points instead of duplicating it');
    // GOL-347 correction: no generic whole-body/MCP contradictions remain.
    assert.doesNotMatch(renderedTracker, /Current tools replace whole bodies/,
      'the old whole-body rule must be scoped away');
    assert.doesNotMatch(renderedTracker, /read first and rewrite in full/,
      'the compatibility ticket_update row must not prescribe whole-body rewrites unconditionally');
    assert.match(renderedTracker, /shared read surface/,
      'the MCP tools table is explicitly the shared read surface');
    assert.match(renderedTracker, /Pi and Claude\s+author through `golem ticket`/,
      'Pi/Claude are pointed at the canonical CLI');
    assert.doesNotMatch(read(path.join(render, 'skills/tracker/SKILL.md')), /sessions_dispatchable/,
      'rendered tracker must not prescribe the compatibility-only discovery tool');
    assert.match(read(path.join(render, 'skills/night-shift/SKILL.md')), /Unattended permission prompts stop the run/,
      'authority clarification retains the unattended stop boundary');
    assert.match(read(path.join(render, 'skills/night-shift/SKILL.md')), /New explicit human authorization can change those limits/,
      'default authority limits do not erase a new human directive');
    assert.match(read(path.join(render, 'skills/team-ops/SKILL.md')), /the human resolves it, not the agent/,
      'comment resolution owner is unambiguous');
    assert.match(read(path.join(render, 'skills/team-ops/SKILL.md')), /explicitly cancel or replace the schedule/,
      'reminder cancel/replace mechanics moved with ownership into team-ops');
    assert.match(rules, /lead personally surveys code and grounds scope and design/);
    assert.doesNotMatch(rules, /Research, surveys, and builds go to the team/);
    assert.match(rules, /golem session --help/);
    assert.match(rules, /golem schedule --help/);
    const leadCard = read(path.join(render, 'roles/lead.md'));
    assert.match(leadCard, /Continue approved stages without another permission prompt/);
    assert.match(leadCard, /Before yielding while a return is expected, create and check a self-reminder/);
    const leadMethod = read(path.join(render, 'skills/lead/SKILL.md'));
    assert.match(leadMethod, /golem:spec-driven-development/,
      'the lead consumes the shared SDD method rather than owning a second copy');
    const teamOpsRender = read(path.join(render, 'skills/team-ops/SKILL.md'));
    assert.match(teamOpsRender, /guidance, not runtime validation/);
    assert.match(teamOpsRender, /same\s+profile or an authorized fallback/);
    assert.match(read(path.join(render, 'skills/night-shift/SKILL.md')), /Golem-managed reminders/);
    const { GOLEM_TOOL_CONTRACTS } = await import(pathToFileURL(path.join(render, 'lib/golem-tool-contracts.js')));
    const create = GOLEM_TOOL_CONTRACTS.find((c) => c.name === 'ticket_create');
    assert.match(create.description, /task→task, spec→spec, doc→doc/);
    assert.match(create.description, /golem:spec-writing/);
    assert.doesNotMatch(create.inputSchema.properties.body.description, /task→feature/);
    console.log(`${target} isolated render and drift check passed`);
  }
  assert.match(read(path.join(state, 'renders/pi/golem.ts')), /follow the assigned role card/);

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  process.env.GOLEM_SMOKE_API = base;
  child = spawn(process.execPath, [path.join(repo, 'dashboard/server/index.js')], {
    cwd: repo, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 20_000;
  while (true) {
    try { await request('/api/health'); break; } catch (error) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`isolated dashboard failed: ${error}\n${stderr}`);
      await ticks(100);
    }
  }
  const templates = await request('/api/templates');
  assert.deepEqual(templates.map((t) => t.id).sort(), ['doc', 'spec', 'spec-html', 'task']);
  const htmlTemplate = templates.find((t) => t.id === 'spec-html');
  assert.equal(htmlTemplate.body_format, 'html');
  assert.match(htmlTemplate.body, /<h1>/);
  for (const t of templates) {
    assert.equal(t.body_format, t.id === 'spec-html' ? 'html' : 'markdown', 'template format metadata');
  }
  const taskTemplate = templates.find((t) => t.id === 'task');
  assert.equal(taskTemplate.body, read(path.join(source, 'skills/tracker/templates/task.md')), 'API task template is the source task template, not only spec-template parity');
  assert.match(taskTemplate.body, /negative cases/);
  assert.match(taskTemplate.body, /cleanup/i);
  assert.match(taskTemplate.body, /who owns the next action/);
  const template = templates.find((t) => t.id === 'spec').body;
  assert.equal(template, read(path.join(source, 'skills/tracker/templates/spec.md')));
  assert.match(template, /golem:spec-writing/);
  assert.doesNotMatch(template, /1–6 diagrams|3–7 subsections|Form: Global Rules/);
  const spec = await createScratchTicket({ kind: 'spec', title: 'instruction contract', body: template });
  tickets.push(spec.id);
  const doc = await createScratchTicket({ kind: 'doc', title: 'research', parent_id: spec.id, body: 'Evidence to consume.' });
  tickets.push(doc.id);
  await request(`/api/tickets/${doc.id}`, { state: 'review', assignee: 'human', actor: 'smoke' }, 'PATCH');
  let returned = await request(`/api/tickets/${doc.id}`);
  assert.equal(returned.state, 'review');
  assert.equal(returned.assignee, 'human');
  await request(`/api/tickets/${doc.id}`, { state: 'done', actor: 'smoke' }, 'PATCH');
  returned = await request(`/api/tickets/${doc.id}`);
  assert.equal(returned.state, 'done');
  const comment = await request(`/api/tickets/${spec.id}/comments`, { author: 'smoke', body: 'Clarify this choice.' });
  await request(`/api/tickets/${spec.id}/comments/${comment.id}/reply`, { author: 'smoke', body: 'Reply in the original thread.' });
  const withReply = await request(`/api/tickets/${spec.id}`);
  assert.ok(withReply.comments.some((c) => c.parent_id === comment.id));

  const intent = 'SMOKE-precise original idea\nPreserve these requirements, not a chosen design.';
  const idea = await request('/api/ideas', { body: intent });
  ideaId = idea.id;
  const promoted = await promoteScratchIdea(ideaId, 'instruction idea');
  tickets.push(promoted.ticket.id);
  assert.equal(promoted.ticket.project_id, SMOKE_PROJECT);
  assert.equal(promoted.ticket.created_by, 'smoke');
  assert.ok(promoted.ticket.body.includes(intent));
  assert.match(promoted.ticket.body, /Requirements discussion/);
  assert.match(promoted.ticket.body, /golem:spec-writing/);
  assert.match(promoted.ticket.body, /after the human's go-ahead/);
  assert.doesNotMatch(promoted.ticket.body, /The chosen direction/);
  assert.equal((await request(`/api/tickets/${promoted.ticket.id}`)).body, promoted.ticket.body);
  assert.equal((await request('/api/ideas')).some((i) => i.id === ideaId), false);
  ideaId = null;
  console.log('real API/SQLite journey passed: template creation, doc disposition, same-thread reply, staged idea promotion');
} finally {
  if (base) {
    for (const id of tickets) await archiveTicket(id);
    if (ideaId) await request(`/api/ideas/${ideaId}/pop`, {}).catch(() => {});
  }
  if (previousApi === undefined) delete process.env.GOLEM_SMOKE_API;
  else process.env.GOLEM_SMOKE_API = previousApi;
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await stopped; } finally { clearTimeout(force); }
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
