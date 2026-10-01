import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function groupPresent(pid) {
  const table = spawnSync('ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    timeout: 2000,
  });
  if (table.error || table.status !== 0)
    throw Error('process-group absence probe indeterminate');
  return table.stdout
    .split('\n')
    .some((line) => Number(line.trim().split(/\s+/)[1]) === pid);
}
const exists = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // Darwin may return EPERM for a just-reaped empty group. Never treat it
    // as absence without a successful OS process-table proof.
    if (error.code === 'EPERM') return groupPresent(pid);
    throw error;
  }
};
export async function cleanupGroups(root) {
  const file = path.join(root, 'groups.jsonl');
  const rows = fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((row) => JSON.parse(row))
    : [];
  for (const { pid, birth } of rows) {
    if (!exists(pid)) continue;
    const current = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (
      current.error ||
      current.status !== 0 ||
      current.stdout.trim() !== birth
    )
      throw Error(
        `owned detached group identity indeterminate; retain ${root}`,
      );
    process.kill(-pid, 'SIGKILL');
    for (let i = 0; i < 100 && exists(pid); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (exists(pid))
      throw Error(`owned detached group survived; retain ${root}`);
  }
  return rows;
}
