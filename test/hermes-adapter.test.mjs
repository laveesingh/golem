import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hermesAdapter from '../lib/compiler/adapters/hermes.js';
import * as compiler from '../lib/compiler/engine.js';
import { createProfile, resolveProfile } from '../lib/model-profiles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SUBSTRATE_ROOT = path.join(REPO_ROOT, 'substrate');

// 1. buildPlan returns expected items
const plan = hermesAdapter.buildPlan({
  substrateRoot: SUBSTRATE_ROOT,
  repoRoot: REPO_ROOT,
  packageVersion: '5.12.0',
});

assert.ok(Array.isArray(plan), 'buildPlan must return an array');
assert.ok(plan.length > 30, 'buildPlan must include skills, roles, hooks, libs, and mcp');

const skillItem = plan.find((i) => i.key.startsWith('skill:') && i.outputRelPath.endsWith('SKILL.md'));
assert.ok(skillItem, 'buildPlan must contain standard SKILL.md items');

const mcpItem = plan.find((i) => i.key.startsWith('mcp:') && i.outputRelPath.includes('index.js'));
assert.ok(mcpItem, 'buildPlan must contain Golem Channel MCP server');

const capItem = plan.find((i) => i.key === 'capabilities');
assert.ok(capItem, 'buildPlan must contain capabilities descriptor');
const caps = JSON.parse(capItem.build());
assert.equal(caps.harness, 'hermes');
assert.equal(caps.tier, 'A');
assert.equal(caps.mcp, true);

// 2. buildInstructionPlan
const instrPlan = hermesAdapter.buildInstructionPlan({ substrateRoot: SUBSTRATE_ROOT });
assert.ok(Array.isArray(instrPlan) && instrPlan.length === 1, 'instruction plan must return AGENTS.md block item');
assert.equal(instrPlan[0].type, 'block');

// 3. Config snippet generation
const snippet = hermesAdapter.generateHermesConfigSnippet({ renderRoot: '/tmp/test-hermes' });
assert.ok(snippet.includes('mcp_servers:'), 'snippet must include mcp_servers');
assert.ok(snippet.includes('golem:'), 'snippet must include golem mcp server');
assert.ok(snippet.includes('hooks:'), 'snippet must include lifecycle hooks');
assert.ok(snippet.includes('hooks_auto_accept: true'), 'snippet must enable auto accept');

// 4. Model profile support for hermes
const testProfileName = `test-hermes-${Date.now()}`;
let testProfile = null;
try {
  testProfile = createProfile({
    name: testProfileName,
    harness: 'hermes',
    provider: 'opencode-go',
    model: 'glm-5.3',
    thinking: 'high',
  });
  assert.equal(testProfile.harness, 'hermes');
  const resolved = resolveProfile(testProfileName);
  assert.equal(resolved.harness, 'hermes');
  assert.equal(resolved.provider, 'opencode-go');
  assert.equal(resolved.model, 'glm-5.3');
} finally {
  try {
    const { deleteProfile } = await import('../lib/model-profiles.js');
    deleteProfile(testProfileName);
  } catch {}
}

console.log('✅ All Hermes adapter and model profile tests passed cleanly!');
