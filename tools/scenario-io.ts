import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScenarioError } from './scenario-format.ts';

export const MAX_SCENARIO_BYTES = 1_048_576;
export function privateTempDirectory(dir: string): string {
  if (!path.isAbsolute(dir))
    throw new ScenarioError(
      'explicit absolute private temporary directory required',
    );
  const stat = fs.lstatSync(dir),
    real = fs.realpathSync(dir);
  const roots = [os.tmpdir(), '/tmp'].map((root) => fs.realpathSync(root));
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    !roots.some((root) => real.startsWith(root + path.sep))
  )
    throw new ScenarioError('temporary directory ownership/type/mode rejected');
  return real;
}
export function readScenarioFile(file: string): unknown {
  if (!path.isAbsolute(file))
    throw new ScenarioError('explicit absolute input path required');
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SCENARIO_BYTES)
      throw new ScenarioError('input must be a bounded regular file');
    const buffer = Buffer.alloc(MAX_SCENARIO_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!count) break;
      length += count;
    }
    if (length > MAX_SCENARIO_BYTES)
      throw new ScenarioError('input grew beyond size limit');
    return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
  } catch {
    throw new ScenarioError('input is not bounded scenario JSON');
  } finally {
    fs.closeSync(fd);
  }
}
/** Exclusive candidate creation: never overwrite an unknown/existing file. */
export function writeCandidate(file: string, value: unknown): void {
  if (!path.isAbsolute(file))
    throw new ScenarioError('explicit absolute output path required');
  privateTempDirectory(path.dirname(file));
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_SCENARIO_BYTES)
    throw new ScenarioError('candidate exceeds size limit');
  const fd = fs.openSync(file, 'wx', 0o600);
  let identity: fs.Stats | null = null;
  try {
    identity = fs.fstatSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      const current = fs.lstatSync(file);
      if (
        identity &&
        current.isFile() &&
        current.uid === identity.uid &&
        current.dev === identity.dev &&
        current.ino === identity.ino
      )
        fs.unlinkSync(file);
    } catch {
      /* Parent owns residual cleanup; never guess a replacement path. */
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}
