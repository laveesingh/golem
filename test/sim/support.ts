// Stage A executable prototype: exact scrubbed transactions, immediate replay.
// No subprocess, installed CLI fallback, model, network, or clock integration.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HARNESSES, ScenarioError, exactKeys, integer, member, record } from '../../tools/scenario-format.ts';
import type { Harness, Scenario, ScenarioEvent, Value } from '../../tools/scenario-format.ts';
import { SYMBOL, validateScenario } from '../../tools/scenario-scrub-core.ts';
import { privateTempDirectory, readScenarioFile, writeCandidate } from '../../tools/scenario-io.ts';

interface Cursor { schema: 1; scenario: Scenario; cursor: number; bindings: Record<string, string> }
function transactions(scenario: Scenario, harness: Harness): ScenarioEvent[][] {
  const groups: ScenarioEvent[][] = []; let current: ScenarioEvent[] | null = null;
  for (const event of scenario.events.filter(e => e.boundary === 'process' && e.fields.harness === harness)) {
    if (event.operation === 'process-spawn') {
      if (current) throw new ScenarioError('overlapping same-harness process transactions unsupported in Stage A');
      current = [event];
    } else {
      if (!current || !['process-stdin', 'process-stdout', 'process-stderr', 'process-exit'].includes(event.operation)) throw new ScenarioError('invalid process transaction ordering');
      current.push(event);
      if (event.operation === 'process-exit') { groups.push(current); current = null; }
    }
  }
  if (current || !groups.length) throw new ScenarioError('no complete process transactions for simulator');
  return groups;
}
function validateBinding(key: string, value: unknown): string {
  const symbol = SYMBOL.exec(key);
  if (!symbol || typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0')) throw new ScenarioError('unsafe runtime symbol binding');
  if (symbol[1] === 'path' && !path.isAbsolute(value)) throw new ScenarioError('path binding must be absolute');
  if (['port', 'pid'].includes(symbol[1]!)) {
    if (!/^\d+$/.test(value)) throw new ScenarioError('numeric binding required');
    integer(Number(value), symbol[1] === 'port' ? 65535 : 0x7fffffff);
    if (symbol[1] === 'pid' && Number(value) === 0) throw new ScenarioError('PID must identify a process');
  }
  return symbol[1]!;
}
function cursorFile(file: string, scenario: Scenario): Cursor {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1, scenario, cursor: 0, bindings: {} }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new ScenarioError('unsafe cursor file');
  const state = record(readScenarioFile(file)); exactKeys(state, ['schema', 'scenario', 'cursor', 'bindings']);
  if (state.schema !== 1 || !isDeepStrictEqual(validateScenario(state.scenario), scenario)) throw new ScenarioError('cursor belongs to another scenario');
  const bindings = record(state.bindings);
  const identities = new Set<string>();
  for (const [key, value] of Object.entries(bindings)) {
    const identity = `${validateBinding(key, value)}\0${value}`;
    if (identities.has(identity)) throw new ScenarioError('distinct symbols collapsed'); identities.add(identity);
  }
  return { schema: 1, scenario, cursor: integer(state.cursor, 10_000), bindings: bindings as Record<string, string> };
}
function bindArg(expected: string, actual: string, bindings: Record<string, string>): void {
  if (!actual || actual.length > 8192 || actual.includes('\0')) throw new ScenarioError('invalid argv');
  const symbol = SYMBOL.exec(expected);
  if (symbol) {
    validateBinding(expected, actual);
    if (Object.hasOwn(bindings, expected) && bindings[expected] !== actual) throw new ScenarioError('symbol identity changed');
    if (!Object.hasOwn(bindings, expected) && Object.entries(bindings).some(([key, value]) => key.startsWith(`$${symbol[1]}:`) && value === actual)) throw new ScenarioError('distinct symbols collapsed');
    bindings[expected] = actual; return;
  }
  if (/^<redacted:(?:argv|prompt|label|provider)>$/.test(expected)) return;
  if (expected !== actual) throw new ScenarioError('argv contract mismatch');
}
function materialize(value: Value, state: Cursor, root: string): Value {
  if (typeof value === 'string') {
    const symbol = SYMBOL.exec(value); if (!symbol) return value;
    if (!Object.hasOwn(state.bindings, value)) {
      state.bindings[value] = symbol[1] === 'path' ? path.join(root, `sim-path-${symbol[2]}`)
        : symbol[1] === 'pid' ? (() => { throw new ScenarioError('unbound PID requires an owned runtime actor in Stage B'); })()
        : symbol[1] === 'port' ? String(30000 + state.scenario.seed % 1000 + Number(symbol[2]))
        : `sim-${state.scenario.seed}-${symbol[1]}-${symbol[2]}`;
    }
    return ['pid', 'port'].includes(symbol[1]!) ? Number(state.bindings[value]) : state.bindings[value]!;
  }
  if (Array.isArray(value)) return value.map(v => materialize(v, state, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, materialize(v, state, root)]));
  return value;
}
function boundedStdin(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); process.stdin.removeListener('data', data); process.stdin.removeListener('end', end); process.stdin.removeListener('error', fail); process.stdin.destroy();
      error ? reject(error) : resolve();
    };
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) finish(new ScenarioError('stdin exceeds bound')); };
    const end = () => finish(bytes ? undefined : new ScenarioError('recorded stdin was absent'));
    const fail = () => finish(new ScenarioError('stdin failed'));
    const cancel = () => finish(new ScenarioError('simulator cancelled'));
    const timer = setTimeout(() => finish(new ScenarioError('stdin deadline exceeded')), 2000);
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', fail);
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  });
}
async function emit(stream: NodeJS.WriteStream, data: string, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const observeError = () => finish(new ScenarioError('stdio write failed'));
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (!error) stream.removeListener('error', observeError);
      error ? reject(error) : resolve();
    };
    const cancel = () => { stream.destroy(); finish(new ScenarioError('simulator cancelled')); };
    // Keep the error observer through late callbacks after a timed-out pipe.
    stream.once('error', observeError);
    const timer = setTimeout(() => { stream.destroy(); finish(new ScenarioError('stdio write deadline exceeded')); }, 2000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel(); else stream.write(data, error => finish(error ? new ScenarioError('stdio write failed') : undefined));
  });
}
export async function runSimulator(harnessValue: string, argv = process.argv.slice(2), signal?: AbortSignal): Promise<{ exitCode: number | undefined; signal?: string }> {
  if (signal?.aborted) throw new ScenarioError('simulator cancelled');
  const harness = member(harnessValue, HARNESSES), input = process.env.GOLEM_SIM_SCENARIO, stateDir = process.env.GOLEM_SIM_STATE_DIR;
  if (!input || !stateDir) throw new ScenarioError('explicit scenario and private temporary cursor directory required');
  const root = privateTempDirectory(stateDir), scenario = validateScenario(readScenarioFile(input)), groups = transactions(scenario, harness);
  const file = path.join(root, `${harness}.json`), lock = file + '.lock';
  const fd = fs.openSync(lock, 'wx', 0o600), lockIdentity = fs.fstatSync(fd);
  let candidate: string | null = null;
  try {
    const state = cursorFile(file, scenario), group = groups[state.cursor];
    if (!group) throw new ScenarioError('scenario exhausted; unknown invocation refused');
    const expected = group[0]!.fields.argv;
    if (!Array.isArray(expected) || expected.length !== argv.length || expected.some(value => typeof value !== 'string')) throw new ScenarioError('argv shape mismatch');
    expected.forEach((value, index) => bindArg(value as string, argv[index]!, state.bindings));
    const inputEvents = group.filter(event => event.operation === 'process-stdin');
    if (inputEvents.length > 1) throw new ScenarioError('multiple stdin records unsupported in Stage A');
    if (inputEvents.length) await boundedStdin(signal);
    if (signal?.aborted) throw new ScenarioError('simulator cancelled');
    const outputs: Array<{ stream: NodeJS.WriteStream; text: string }> = [];
    for (const event of group.slice(1)) {
      if (event.operation === 'process-stdout') {
        let text: string;
        if (event.fields.stdout_recipe === 'version') text = (harness === 'herdr' ? 'herdr ' : '') + String(event.fields.version ?? scenario.source.harness_version) + '\n';
        else if (event.fields.stdout_recipe === 'empty') text = '';
        else if (event.fields.stdout_recipe === 'json' && event.fields.result) text = JSON.stringify(materialize(event.fields.result, state, root)) + '\n';
        else if (typeof event.fields.stdout === 'string') text = event.fields.stdout + '\n';
        else throw new ScenarioError('missing scrubbed stdout recipe');
        outputs.push({ stream: process.stdout, text });
      } else if (event.operation === 'process-stderr') {
        if (typeof event.fields.stderr !== 'string') throw new ScenarioError('missing scrubbed stderr');
        outputs.push({ stream: process.stderr, text: event.fields.stderr + '\n' });
      }
    }
    const end = group.at(-1)!;
    const exitCode = end.fields.exit_code === undefined ? undefined : integer(end.fields.exit_code, 255), recordedSignal = end.fields.signal;
    if (recordedSignal !== undefined) member(recordedSignal, ['SIGTERM', 'SIGINT', 'SIGHUP']);
    state.cursor++;
    candidate = path.join(root, `${harness}.${randomUUID()}.tmp`); writeCandidate(candidate, state);
    // Cooperative exclusivity; never follow/replace unknown symlinks.
    cursorFile(file, scenario);
    fs.renameSync(candidate, file); candidate = null;
    for (const output of outputs) await emit(output.stream, output.text, signal);
    return { exitCode, ...(typeof recordedSignal === 'string' ? { signal: recordedSignal } : {}) };
  } finally {
    if (candidate) { try { fs.unlinkSync(candidate); } catch {} }
    fs.closeSync(fd);
    const current = fs.lstatSync(lock);
    if (!current.isFile() || current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) throw new ScenarioError('lock identity changed; unknown path retained');
    fs.unlinkSync(lock);
  }
}
export async function simulatorMain(harness: string): Promise<void> {
  const controller = new AbortController(); let received: NodeJS.Signals | undefined, recorded: NodeJS.Signals | undefined;
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  const handlers = signals.map(signal => { const handler = () => { received ??= signal; controller.abort(); }; process.on(signal, handler); return {signal,handler}; });
  try { const outcome = await runSimulator(harness, process.argv.slice(2), controller.signal); process.exitCode = outcome.exitCode; recorded = outcome.signal as NodeJS.Signals | undefined; }
  catch (error) { if (!received) console.error(error instanceof ScenarioError ? `simulator: ${error.message}` : 'simulator: input/state/stdio ownership failure'); process.exitCode = 2; }
  finally {
    for (const {signal,handler} of handlers) process.removeListener(signal, handler);
    // Re-raise only after the owned cursor lock/candidate cleanup has returned.
    if (received || recorded) process.kill(process.pid, (received ?? recorded)!);
    else process.exit(Number(process.exitCode ?? 0)); // Dedicated CLI: pending pipe drain cannot keep it alive after cleanup.
  }
}
