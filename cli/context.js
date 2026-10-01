import { MANAGEMENT_SELECTOR_FLAGS, managementQuery } from '../lib/management-cli.js';
export const CONTEXT_HELP = 'golem context [--project P] [--team T] [--session S] [--caller ID] [--json]\n\nRead-only selected scope, provenance, candidates and unavailable evidence. Cwd supplies project only; native UI focus is never caller evidence.';
export async function runContext(args, { stdout = text => process.stdout.write(`${text}\n`), stderr = text => process.stderr.write(`${text}\n`), ...collector } = {}) {
  const options = {};
  try {
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (['--help', '-h'].includes(flag)) { stdout(CONTEXT_HELP); return 0; }
      if (Object.hasOwn(options, flag)) throw new Error(`duplicate option: ${flag}`);
      if (flag === '--json') options[flag] = true;
      else if (MANAGEMENT_SELECTOR_FLAGS[flag]) {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
        options[flag] = args[++i];
      } else throw new Error(`unknown option: ${flag}`);
    }
    const { resolution } = await managementQuery({ operation: 'context', kind: 'context', options, ...collector });
    stdout(options['--json'] ? JSON.stringify({ ok: resolution.ok, resolution }) : JSON.stringify(resolution, null, 2));
    return resolution.ok ? 0 : 2;
  } catch (error) {
    if (options['--json']) stdout(JSON.stringify({ ok: false, error: error.message })); else stderr(error.message);
    return 2;
  }
}
