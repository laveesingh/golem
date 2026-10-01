// Loaded before any test/module import in native children. No authored text is read.

import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const root = process.env.GOLEM_W2_SANDBOX;
if (!root || !process.env.HOME?.startsWith(root + path.sep))
  throw Error('missing W2 isolation before import');
const native = new Set([
  'claude',
  'pi',
  'herdr',
  'cloudflared',
  'security',
  'op',
  'aws',
  'gcloud',
  'curl',
  'wget',
]);
function checkCommand(command, args) {
  const text = String(command);
  if (!native.has(path.basename(text))) return command;
  const options =
    args.find(
      (value) => value && typeof value === 'object' && !Array.isArray(value),
    ) ?? {};
  const search = (options.env?.PATH ?? process.env.PATH ?? '').split(
    path.delimiter,
  );
  const candidate = path.isAbsolute(text)
    ? text
    : search
        .map((dir) => path.join(dir, text))
        .find((file) => fs.existsSync(file));
  // Preserve ENOENT without allowing fallback to an installed native binary.
  if (!candidate) return path.join(root, 'missing-native', path.basename(text));
  if (!fs.realpathSync(candidate).startsWith(fs.realpathSync(root) + path.sep))
    throw Error(`W2 refused non-fixture or missing native executable: ${text}`);
  return candidate;
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[name];
  childProcess[name] = function (command, ...args) {
    const checked = checkCommand(command, args);
    const child = original.call(this, checked, ...args);
    if (name === 'spawn' && args.some((value) => value?.detached === true)) {
      child.once('spawn', () => {
        const birth = childProcess.spawnSync(
          'ps',
          ['-p', String(child.pid), '-o', 'lstart='],
          { encoding: 'utf8' },
        );
        if (birth.status === 0 && birth.stdout.trim())
          fs.appendFileSync(
            path.join(root, 'groups.jsonl'),
            JSON.stringify({ pid: child.pid, birth: birth.stdout.trim() }) +
              '\n',
          );
      });
    }
    return child;
  };
  if (original[promisify.custom]) {
    childProcess[name][promisify.custom] = function (command, ...args) {
      const checked = checkCommand(command, args);
      return original[promisify.custom].call(this, checked, ...args);
    };
  }
}
function checkAddress(port, host) {
  if ([7420, 7421].includes(Number(port)))
    throw Error(`W2 refused production port: ${port}`);
  if (
    host &&
    !['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(host)
  )
    throw Error(`W2 refused external host: ${host}`);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const value = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof value === 'object' && value !== null && !value.path)
    checkAddress(value.port, value.host);
  else if (typeof value === 'number') checkAddress(value, args[1]);
  return connect.apply(this, args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const value = args[0];
  if (typeof value === 'object' && value !== null && !value.path)
    checkAddress(value.port, value.host);
  else if (typeof value === 'number')
    checkAddress(value, typeof args[1] === 'string' ? args[1] : undefined);
  return listen.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  );
  checkAddress(
    url.port || (url.protocol === 'https:' ? 443 : 80),
    url.hostname,
  );
  return fetch(input, ...args);
};
syncBuiltinESMExports();
