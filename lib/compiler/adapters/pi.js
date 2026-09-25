// Pi is a Tier-A first-class worker: the adapter remains deliberately thin
// while shared Golem modules own delivery, tools, facts, and recovery.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, sha256File } from '../engine.js';


function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    return entry.isDirectory() ? files(abs) : [abs];
  });
}

function item(key, outputRelPath, source) {
  return { key, outputRelPath, sourceSha256: sha256File(source), build: () => fs.readFileSync(source) };
}

export function buildPlan({ repoRoot, substrateRoot: suppliedSubstrateRoot, packageVersion }) {
  const substrateRoot = suppliedSubstrateRoot || process.env.GOLEM_SUBSTRATE_ROOT || path.join(repoRoot, 'substrate');
  // Every role card ships (GOL-382 R1); the role list is the instructions' call, not the adapter's.
  const rolesRoot = path.join(substrateRoot, 'roles');
  const roles = fs.existsSync(rolesRoot)
    ? fs.readdirSync(rolesRoot).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).sort()
    : [];
  const extension = path.join(repoRoot, 'shims', 'pi', 'golem.ts');
  const capabilities = {
    schema: 1, harness: 'pi', tier: 'A', lifecycle: true, mcp: false, subagents: false,
    native_tools: true, resources: ['instructions', 'roles', 'skills', 'project-context'],
    roles,
    delivery: ['typed-worker', 'next_turn_migration'], push_delivery: true, node: '>=22.19',
    limitation: 'Pi runs as a first-class participant in any registered role; no Pi-native subagents. Extensions run with host-full-trust.',
  };
  const pkg = { name: '@laveesingh/golem-pi-extension', version: packageVersion, private: true, type: 'module', pi: { extensions: ['./golem.ts'], skills: ['./skills'] } };
  const readme = '# Golem for Pi (Tier A worker)\n\nRequires `@earendil-works/pi-coding-agent` and Node.js >=22.19. Launch any configured native Pi provider with `golem pi --provider <provider> --model <model>` or `golem pi --role <role>` for a role preset.\n\nThe launcher appends this canonical render as an explicit Pi extension; refresh it with `golem sync --target pi`. Pi retains its own profile, authentication, models, providers, extensions, and sessions; Golem neither copies nor manages Pi configuration. The extension registers shared Golem tools, injects Golem-owned instructions and the role card of the session at safe turn boundaries, exposes progressive skills, renders bounded project context, and provides authenticated typed-worker delivery. Pre-acceptance failures remain replayable; accepted work interrupted by a crash is outcome-unknown and requires an explicit correlated recovery/redispatch. Pi extensions execute with the user\'s full host authority: project trust is not a sandbox. Pi-native subagents and bundled browser/LSP features are deferred.\n';
  const runtime = [
    'golem-home.js', 'project-id.js', 'session-facts.js', 'typed-worker-endpoint.js',
    'typed-delivery-tombstones.js', 'pi-native-adapter.js', 'session-registry.js', 'golem-client.js',
    'golem-tool-contracts.js', 'golem-tool-runtime.js', 'session-role.js',
  ].map((name) => item(`runtime:${name}`, `lib/${name}`, path.join(repoRoot, 'lib', name)));
  const resources = [];
  resources.push(item('instructions:AGENTS.md', 'instructions/AGENTS.md', path.join(substrateRoot, 'instructions', 'AGENTS.md')));
  for (const role of roles) resources.push(item(`role:${role}`, `roles/${role}.md`, path.join(substrateRoot, 'roles', `${role}.md`)));
  const skillsRoot = path.join(substrateRoot, 'skills');
  const allSkills = fs.existsSync(skillsRoot)
    ? fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  for (const skill of allSkills) {
    const root = path.join(substrateRoot, 'skills', skill);
    for (const abs of files(root)) {
      const rel = path.relative(path.join(substrateRoot, 'skills'), abs);
      resources.push(item(`skill:${rel}`, path.join('skills', rel), abs));
    }
  }
  for (const name of ['tracker-context.sh', '_golem-home.sh']) {
    resources.push(item(`hook:${name}`, `hooks/${name}`, path.join(substrateRoot, 'hooks', name)));
  }
  return [item('extension', 'golem.ts', extension), ...runtime, ...resources, ...[
    ['capabilities', 'capabilities.json', capabilities], ['package', 'package.json', pkg], ['readme', 'README.md', readme],
  ].map(([key, outputRelPath, value]) => ({ key, outputRelPath, sourceSha256: sha256(JSON.stringify(value)), build: () => typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n` }))];
}
