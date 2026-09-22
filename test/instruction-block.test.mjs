#!/usr/bin/env node
// Block RenderItem semantics for the global instruction file
// (~/.claude/CLAUDE.md). This destination is shared with the human: golem owns
// the marked region, they own everything else. The engine previously replaced
// the WHOLE file when no managed region was found, which silently deleted
// pre-existing human content on first adoption. These tests exist so that
// cannot come back.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-block-'));
process.env.GOLEM_HOME = path.join(tmpHome, 'golem');
fs.mkdirSync(process.env.GOLEM_HOME, { recursive: true });

const compiler = await import('../lib/compiler/engine.js');

const BEGIN = '<!-- golem:instructions:begin -->';
const END = '<!-- golem:instructions:end -->';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed += 1; }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); failed += 1; }
}

function item(inner) {
  return {
    key: 'instructions:AGENTS.md',
    outputRelPath: 'AGENTS.md',
    sourceSha256: compiler.sha256(inner),
    type: 'block',
    beginMarker: BEGIN,
    endMarker: END,
    build: () => inner,
  };
}

function freshOut(name) {
  const dir = path.join(tmpHome, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function render(outDir, inner, { force = false, target = 'cc-instructions' } = {}) {
  return compiler.render({ target, outDir, items: [item(inner)], packageVersion: '0.0.0', force });
}

console.log('instruction block semantics');

check('creates the file with just the block when the destination is absent', () => {
  const out = freshOut('absent');
  render(out, 'RULES v1');
  const text = fs.readFileSync(path.join(out, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes(BEGIN) && text.includes(END));
  assert.ok(text.includes('RULES v1'));
});

check('adopting a human-authored file APPENDS and never truncates it', () => {
  const out = freshOut('adopt');
  const human = '# My own Codex rules\nAlways use tabs.\n';
  fs.writeFileSync(path.join(out, 'AGENTS.md'), human);
  const result = render(out, 'RULES v1');
  const text = fs.readFileSync(path.join(out, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('# My own Codex rules'), 'human heading was destroyed');
  assert.ok(text.includes('Always use tabs.'), 'human rule was destroyed');
  assert.ok(text.includes('RULES v1'), 'golem block missing');
  assert.equal(result.tampered.length, 0, 'adoption must not report tamper');
});

check('adoption does not require --force', () => {
  const out = freshOut('adopt-noforce');
  fs.writeFileSync(path.join(out, 'AGENTS.md'), 'human text\n');
  const result = render(out, 'RULES v1');
  assert.equal(result.written.length, 1);
  assert.equal(result.tampered.length, 0);
});

check('re-render replaces only the managed region, keeping text on both sides', () => {
  const out = freshOut('resync');
  fs.writeFileSync(path.join(out, 'AGENTS.md'), 'PREFIX\n');
  render(out, 'RULES v1');
  fs.appendFileSync(path.join(out, 'AGENTS.md'), 'SUFFIX added later\n');
  render(out, 'RULES v2');
  const text = fs.readFileSync(path.join(out, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('PREFIX'), 'prefix lost');
  assert.ok(text.includes('SUFFIX added later'), 'suffix lost');
  assert.ok(text.includes('RULES v2'), 'block not updated');
  assert.ok(!text.includes('RULES v1'), 'old block content still present');
  assert.equal(text.split(BEGIN).length - 1, 1, 'duplicate begin marker');
});

check('a damaged marker set is refused, and the file is left untouched', () => {
  const out = freshOut('damaged');
  const damaged = `keep me\n${BEGIN}\norphan, no end marker\n`;
  fs.writeFileSync(path.join(out, 'AGENTS.md'), damaged);
  const result = render(out, 'RULES v1');
  assert.equal(result.tampered.length, 1, 'damaged block must report tamper');
  assert.equal(fs.readFileSync(path.join(out, 'AGENTS.md'), 'utf8'), damaged, 'file was modified');
});

check('--force on a damaged file still preserves the existing content', () => {
  const out = freshOut('damaged-force');
  const damaged = `precious human notes\n${BEGIN}\norphan\n`;
  fs.writeFileSync(path.join(out, 'AGENTS.md'), damaged);
  render(out, 'RULES v1', { force: true });
  const text = fs.readFileSync(path.join(out, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('precious human notes'), 'force destroyed human content');
});

console.log('');

console.log('');
console.log(failed ? `FAILED (${failed} of ${passed + failed})` : `ALL PASS (${passed} checks)`);
process.exit(failed ? 1 : 0);
