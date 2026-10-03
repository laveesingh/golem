import fs from 'node:fs';
import path from 'node:path';
import { processBirth } from '../../lib/management-lock.js';
import {
  processGroupMatches,
  processGroupProcesses,
} from '../../lib/process-group.js';

// The allocation snapshot precedes source entry. Runtime guard observations
// extend that same group's owned members, allowing residual-child cleanup
// without borrowing authority from a reused numeric leader PID.
export function mainIdentityWithMembers(identity, root) {
  const file = path.join(root, 'main-members.jsonl');
  const observed = fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const members = [...identity.members];
  for (const member of observed.filter((row) => row.pgid === identity.pgid)) {
    if (
      !members.some(
        (row) => row.pid === member.pid && row.birth === member.birth,
      )
    )
      members.push({ pid: member.pid, birth: member.birth });
  }
  return { ...identity, members };
}
export async function stopMainGroup(
  identity,
  root,
  { probe = processBirth, beforeSignal = () => {} } = {},
) {
  if (!identity?.pgid || !identity.members?.length)
    throw Error(`main ownership capture indeterminate; retain ${root}`);
  const current = mainIdentityWithMembers(identity, root);
  const verify = () => {
    const rows = processGroupProcesses(current.pgid);
    if (!rows.length) {
      if (current.members.some((member) => probe(member.pid) === member.birth))
        throw Error(
          `owned main incarnation remains outside its group; retain ${root}`,
        );
      return false;
    }
    if (!processGroupMatches(current.pgid, current, { probe })) {
      // Last owned member may exit between the table and birth observations.
      if (
        !processGroupProcesses(current.pgid).length &&
        !current.members.some((member) => probe(member.pid) === member.birth)
      )
        return false;
      throw Error(
        `main group incarnation changed or indeterminate; no signal; retain ${root}`,
      );
    }
    return true;
  };
  if (!verify()) return current;
  beforeSignal(current);
  // Synchronous current group + birth fence immediately BEFORE every signal.
  if (!verify()) return current;
  try {
    process.kill(-current.pgid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH' && !(error.code === 'EPERM' && !verify()))
      throw error;
  }
  for (let i = 0; i < 100; i++) {
    if (!verify()) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`owned main group survived fenced cleanup; retain ${root}`);
}
