// Unit means no processes or network, even if a future fixture is misclassified.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

const forbidden = () => {
  throw Error('unit forbids processes/network; use integration');
};
for (const key of [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
])
  childProcess[key] = forbidden;
net.Socket.prototype.connect = forbidden;
net.Server.prototype.listen = forbidden;
globalThis.fetch = forbidden;
syncBuiltinESMExports();
