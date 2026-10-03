import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repo = fileURLToPath(new URL('../../', import.meta.url));

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, NODE_PATH: '' },
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function snapshot(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      assert.notEqual(entry.name, 'node_modules');
      const file = path.join(root, entry.name);
      return entry.isDirectory()
        ? snapshot(file).map(([name, data]) => [`${entry.name}/${name}`, data])
        : [[entry.name, fs.readFileSync(file).toString('base64')]];
    });
}

async function protocol(entry, cwd) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, NODE_PATH: '', GOLEM_CHANNEL_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  lines.on('line', (line) => {
    const value = JSON.parse(line);
    if (pending.has(value.id)) {
      const resolve = pending.get(value.id);
      pending.delete(value.id);
      resolve(value);
    }
  });
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const request = (method, params) => {
    const id = ++nextId;
    return Promise.race([
      new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        );
      }),
      exited.then((result) => {
        throw Error(`MCP exited ${JSON.stringify(result)}: ${stderr}`);
      }),
    ]);
  };
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'isolated-artefact', version: '1' },
    });
    assert.ok(initialized.result, JSON.stringify(initialized));
    child.stdin.write(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    );
    const list = await request('tools/list', {});
    assert.equal(list.result.tools.length, 11);
    // Invalid protocol shape must be rejected without a tracker request.
    const malformed = await request('tools/call', {
      name: 'ticket_get',
      arguments: [],
    });
    assert.equal(malformed.error.code, -32603);
    assert.match(malformed.error.message, /arguments/);
    const missing = await request('tools/call', {
      name: 'ticket_get',
      arguments: {},
    });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /id is required/);
  } finally {
    child.stdin.end();
    const result = await exited;
    clearTimeout(deadline);
    lines.close();
    assert.equal(result.code, 0, stderr);
  }
}

test('real CC and Pi sync outputs run without repository dependencies and repeat byte-for-byte', async () => {
  const root = fs.mkdtempSync(
    path.join(process.env.GOLEM_W2_SANDBOX, 'artefact-'),
  );
  const cwd = path.join(root, 'empty');
  fs.mkdirSync(cwd);
  assert.deepEqual(fs.readdirSync(cwd), []);
  for (let parent = fs.realpathSync(cwd); ; parent = path.dirname(parent)) {
    assert.equal(
      fs.existsSync(path.join(parent, 'node_modules')),
      false,
      parent,
    );
    if (parent === path.dirname(parent)) break;
  }
  try {
    for (const target of ['cc', 'pi']) {
      const out = path.join(root, target);
      const args = [
        path.join(repo, 'cli/golem-bin.js'),
        'sync',
        '--target',
        target,
        '--out',
        out,
      ];
      run(args, cwd);
      const first = snapshot(out);
      run(args, cwd);
      assert.deepEqual(snapshot(out), first);
      run([...args, '--check'], cwd);
      const marker = JSON.parse(
        fs.readFileSync(path.join(out, '.golem-render.json')),
      );
      assert.equal(marker.target, target);
      assert.deepEqual(
        fs.readdirSync(path.join(out, 'contracts/dist')).sort(),
        fs.readdirSync(path.join(repo, 'contracts/dist')).sort(),
      );
      assert.equal(
        first.filter(([name]) => name.endsWith('.ts')).length,
        target === 'pi' ? 1 : 0,
      );
      // Native Node imports every helper; no Vitest transform or package lookup.
      run(
        [
          '--input-type=module',
          '-e',
          `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import {pathToFileURL} from 'node:url';
        const root = ${JSON.stringify(out)};
        for (const name of fs.readdirSync(path.join(root, 'lib'))) {
          // CC's hook writer is a CLI entry, not an importable helper.
          if (name !== 'session-facts-write.js') await import(pathToFileURL(path.join(root, 'lib', name)));
        }
        const roles = await import(pathToFileURL(path.join(root, 'lib/session-role.js')));
        const location = await import(pathToFileURL(path.join(root, 'lib/package-root.js')));
        assert.equal(location.packageRoot(pathToFileURL(path.join(root, 'lib/session-role.js'))), root);
        for (const name of fs.readdirSync(path.join(root, 'roles'))) {
          assert.equal(roles.readRoleCard(name.slice(0, -3)), fs.readFileSync(path.join(root, 'roles', name), 'utf8').trimEnd());
        }
      `,
        ],
        cwd,
      );
      if (target === 'cc') {
        assert.deepEqual(fs.readdirSync(path.join(out, 'mcp/channel')).sort(), [
          'index.js',
          'package.json',
        ]);
        // No consumer may reference the retired dependency tree.
        assert.doesNotMatch(
          fs.readFileSync(path.join(out, '.mcp.json'), 'utf8'),
          /node_modules/,
        );
        await protocol(path.join(out, 'mcp/channel/index.js'), cwd);
        // Upgrade cleanup removes the old untracked dependency tree.
        fs.mkdirSync(path.join(out, 'mcp/channel/node_modules/stale'), {
          recursive: true,
        });
        run(args, cwd);
        assert.deepEqual(snapshot(out), first);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
