// Hermes Agent adapter (GOL-39).
// Renders substrate/ into Hermes Agent's execution environment:
//   - skills/           -> ~/.hermes/skills/<slug>/SKILL.md (standard agentskills.io format)
//   - instructions      -> ~/.hermes/AGENTS.md (managed instruction block)
//   - mcp & hooks       -> ~/.hermes/config.yaml (mcp_servers.golem + shell lifecycle hooks)
//   - render bundle     -> ~/.golem/renders/hermes/ (MCP server, runtime libs, and hooks)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTemplate, sha256, sha256File } from '../engine.js';

const CONTEXT = { hermes: true };

const INSTRUCTIONS_BEGIN = '<!-- golem:instructions:begin -->';
const INSTRUCTIONS_END = '<!-- golem:instructions:end -->';

function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    return entry.isDirectory() ? files(abs) : [abs];
  });
}

function item(key, outputRelPath, source, build = () => fs.readFileSync(source)) {
  return { key, outputRelPath, sourceSha256: sha256File(source), build };
}

/** HERMES_HOME, where Hermes reads its configuration and global skills. */
export function hermesHome() {
  return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
}

export function instructionOutDir() {
  return hermesHome();
}

export function skillsOutDir() {
  return path.join(hermesHome(), 'skills');
}

export function buildInstructionPlan({ substrateRoot }) {
  const abs = path.join(substrateRoot, 'instructions', 'AGENTS.md');
  if (!fs.existsSync(abs)) return [];
  return [{
    key: 'instructions:AGENTS.md',
    outputRelPath: 'AGENTS.md',
    sourceSha256: sha256File(abs),
    type: 'block',
    beginMarker: INSTRUCTIONS_BEGIN,
    endMarker: INSTRUCTIONS_END,
    build: () => applyTemplate(fs.readFileSync(abs, 'utf8'), CONTEXT),
  }];
}

export function buildPlan({ substrateRoot, repoRoot, packageVersion }) {
  const out = [];

  // 1. Skills -> skills/<slug>/...
  for (const abs of files(path.join(substrateRoot, 'skills'))) {
    const rel = path.relative(path.join(substrateRoot, 'skills'), abs);
    out.push(item(`skill:${rel}`, `skills/${rel}`, abs, () =>
      path.basename(abs) === 'SKILL.md'
        ? applyTemplate(fs.readFileSync(abs, 'utf8'), CONTEXT)
        : fs.readFileSync(abs)));
  }

  // 2. Roles -> roles/<role>.md
  const rolesDir = path.join(substrateRoot, 'roles');
  if (fs.existsSync(rolesDir)) {
    for (const abs of files(rolesDir)) {
      if (!abs.endsWith('.md')) continue;
      const rel = path.relative(rolesDir, abs);
      out.push(item(`role:${rel}`, `roles/${rel}`, abs));
    }
  }

  // 3. Hooks -> hooks/hook.mjs + helpers
  const hook = path.join(repoRoot, 'shims', 'hermes', 'hook.mjs');
  if (fs.existsSync(hook)) {
    out.push(item('hook:hook.mjs', 'hooks/hook.mjs', hook));
  } else {
    const shimHook = path.join(repoRoot, 'shims', 'codex', 'hook.mjs');
    if (fs.existsSync(shimHook)) out.push(item('hook:hook.mjs', 'hooks/hook.mjs', shimHook));
  }

  for (const name of ['tracker-context.sh', '_golem-home.sh']) {
    const abs = path.join(substrateRoot, 'hooks', name);
    if (fs.existsSync(abs)) out.push(item(`hook:${name}`, `hooks/${name}`, abs));
  }

  // 4. Runtime Libs -> lib/
  for (const rel of [
    'golem-home.js', 'project-id.js', 'session-facts.js', 'session-registry.js', 'session-role.js',
    'golem-client.js', 'golem-tool-contracts.js', 'golem-tool-runtime.js',
  ]) {
    const abs = path.join(repoRoot, 'lib', rel);
    if (fs.existsSync(abs)) out.push(item(`lib:${rel}`, `lib/${rel}`, abs));
  }

  // 5. MCP Channel Server -> mcp/channel/
  const channelRoot = path.join(repoRoot, 'mcp', 'channel');
  for (const abs of files(channelRoot).filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`))) {
    const rel = path.relative(channelRoot, abs);
    out.push(item(`mcp:${rel}`, `mcp/channel/${rel}`, abs));
  }

  // 6. Capabilities descriptor
  const capabilities = {
    schema: 1,
    harness: 'hermes',
    tier: 'A',
    lifecycle: true,
    mcp: true,
    subagents: true,
    delivery: ['push', 'pull'],
    push_delivery: true,
    worktrees: true,
    multi_provider: true,
  };

  out.push({
    key: 'capabilities',
    outputRelPath: 'capabilities.json',
    sourceSha256: sha256(JSON.stringify(capabilities)),
    build: () => `${JSON.stringify(capabilities, null, 2)}\n`,
  });

  return out;
}

/**
 * Generate YAML snippet for ~/.hermes/config.yaml configuring Golem MCP server and hooks.
 */
export function generateHermesConfigSnippet({ renderRoot }) {
  const channelPath = path.join(renderRoot, 'mcp', 'channel', 'index.js');
  const hookPath = path.join(renderRoot, 'hooks', 'hook.mjs');
  return `
# Golem Substrate Integration
hooks_auto_accept: true
mcp_servers:
  golem:
    command: "node"
    args: ["${channelPath}"]
    env:
      GOLEM_PROJECT_DIR: "\${workspaceFolder}"
    enabled: true
    timeout: 120

hooks:
  on_session_start:
    - command: "node \\"${hookPath}\\" session-start"
      timeout: 10
  pre_tool_call:
    - command: "node \\"${hookPath}\\" tool-pre"
      timeout: 15
  post_tool_call:
    - command: "node \\"${hookPath}\\" tool-post"
      timeout: 15
  on_session_end:
    - command: "node \\"${hookPath}\\" stop"
      timeout: 10
`;
}

/**
 * Automatically ensure ~/.hermes/config.yaml has mcp_servers.golem and hooks.
 */
export function ensureHermesConfigured({ renderRoot = path.join(os.homedir(), '.golem', 'renders', 'hermes') } = {}) {
  const configFile = path.join(hermesHome(), 'config.yaml');
  if (!fs.existsSync(configFile)) return false;
  const content = fs.readFileSync(configFile, 'utf8');
  if (content.includes('mcp_servers:') && content.includes('golem:')) return false;

  const snippet = generateHermesConfigSnippet({ renderRoot });
  fs.appendFileSync(configFile, `\n${snippet}\n`);
  return true;
}
