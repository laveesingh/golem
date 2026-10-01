import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface Profile { name: string; port: number; created_at: string; checkout: string }
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Keep native Unix socket spellings short; canonical data stays in the profile. */
export function profileNamespaceAlias(root: string): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('profile native namespace requires Unix ownership support');
  const digest = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  const ownerDir = path.join('/tmp', `gp-${uid}-${digest}`);
  try { fs.mkdirSync(ownerDir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const owner = fs.lstatSync(ownerDir);
  if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== uid || (owner.mode & 0o777) !== 0o700) throw new Error(`unsafe profile namespace owner directory: ${ownerDir}`);
  const alias = path.join(ownerDir, 'c');
  const target = path.join(path.resolve(root), 'xdg', 'config');
  if (fs.readdirSync(ownerDir).some(name => name !== 'c')) throw new Error(`unknown entries in profile namespace: ${ownerDir}`);
  try { fs.symlinkSync(target, alias, 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const link = fs.lstatSync(alias);
  if (!link.isSymbolicLink() || link.uid !== uid || fs.readlinkSync(alias) !== target) throw new Error(`unsafe profile namespace alias: ${alias}`);
  assertNativeSocketLength(alias);
  return alias;
}

export function assertNativeSocketLength(configDir: string, session = `g-${'a'.repeat(28)}`): void {
  const socket = path.join(configDir, 'herdr', 'sessions', session, 'herdr-client.sock');
  // Darwin sun_path has 104 bytes, including the NUL. Use its portable limit.
  if (Buffer.byteLength(socket) > 103) throw new Error(`profile native socket path exceeds 103 bytes: ${socket}`);
}

function takeOption(args: string[], key: string): string | undefined {
  const separator = args.indexOf('--');
  const indexes = args.slice(0, separator < 0 ? undefined : separator).flatMap((arg, i) => arg === key || arg.startsWith(`${key}=`) ? [i] : []);
  if (indexes.length > 1) throw new Error(`${key} may only be supplied once`);
  const i = indexes[0];
  if (i === undefined) return undefined;
  const arg = args[i]!;
  const value = arg === key ? args[i + 1] : arg.slice(key.length + 1);
  if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
  args.splice(i, arg === key ? 2 : 1);
  return value;
}

export function resolveProfile(args: string[], env: NodeJS.ProcessEnv = process.env): Profile | null {
  // Only the global prefix belongs to bootstrap. Agent/Pi model --profile
  // flags after the verb must remain owned by their existing command parser.
  let prefixLength = 0;
  while (prefixLength < args.length) {
    const arg = args[prefixLength]!;
    if (arg === '--profile' || arg === '--port') prefixLength += 2;
    else if (arg.startsWith('--profile=') || arg.startsWith('--port=')) prefixLength++;
    else break;
  }
  const prefix = args.slice(0, prefixLength);
  const name = takeOption(prefix, '--profile');
  if (name === undefined) return null;
  args.splice(0, prefixLength, ...prefix);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error('invalid profile name: use 1–32 lowercase letters, digits, _ or -, starting with a letter');
  const portArg = takeOption(args, '--port');
  const requested = portArg === undefined ? undefined : Number(portArg);
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65533 || [4173, 5173, 61000, 7420, 7421].some(p => p >= requested && p <= requested + 2))) {
    throw new Error('--port requires a non-default three-port block from 1 to 65533; port 0 is not supported');
  }
  const root = path.resolve(env.HOME || os.homedir(), '.golem-profiles', name);
  const file = path.join(root, 'profile.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    const hash = createHash('sha256').update(name).digest().readUInt32BE(0);
    const initial: Profile = { name, port: requested ?? 18000 + hash % 10000 * 3, created_at: new Date().toISOString(), checkout };
    try { fs.writeFileSync(file, `${JSON.stringify(initial, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const profile = JSON.parse(fs.readFileSync(file, 'utf8')) as Profile;
  if (profile.name !== name || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65533 || [4173, 5173, 61000, 7420, 7421].some(p => p >= profile.port && p <= profile.port + 2)) throw new Error(`invalid profile manifest: ${file}`);
  if (requested !== undefined && requested !== profile.port) throw new Error(`profile ${name} owns port ${profile.port}; --port cannot change its persisted block`);
  const dirs: Record<string, string> = {
    GOLEM_HOME: path.join(root, 'golem'), CLAUDE_CONFIG_DIR: path.join(root, 'home', '.claude'),
    PI_CODING_AGENT_DIR: path.join(root, 'home', '.pi', 'agent'), PI_CODING_AGENT_SESSION_DIR: path.join(root, 'pi-sessions'),
    XDG_CONFIG_HOME: path.join(root, 'xdg', 'config'), XDG_DATA_HOME: path.join(root, 'xdg', 'data'),
    XDG_STATE_HOME: path.join(root, 'xdg', 'state'), XDG_CACHE_HOME: path.join(root, 'xdg', 'cache'), XDG_RUNTIME_DIR: path.join(root, 'xdg', 'run'),
    GOLEM_USER_SKILLS_ROOT: path.join(root, 'agents', 'skills'), GOLEM_PROJECTS_ROOT: path.join(root, 'projects'), GOLEM_IDEAS_ROOT: path.join(root, 'ideas'),
  };
  for (const [key, dir] of Object.entries(dirs)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); env[key] = dir; }
  env.XDG_CONFIG_HOME = profileNamespaceAlias(root);
  Object.assign(env, {
    GOLEM_PROFILE: name, GOLEM_PROFILE_ROOT: root, GOLEM_ROOT: checkout, HOST: '127.0.0.1', PORT: String(profile.port),
    GOLEM_VITE_PORT: String(profile.port + 1), GOLEM_LADLE_PORT: String(profile.port + 2),
    GOLEM_VITE_CACHE_DIR: path.join(dirs.GOLEM_HOME!, 'vite-cache'),
    GOLEM_DASHBOARD_URL: `http://127.0.0.1:${profile.port}`,
    // The legacy channel fallback must never reach the production 7421 port.
    GOLEM_CHANNEL_URL: `http://127.0.0.1:${profile.port}/profile-channel-unavailable`,
    GOLEM_SUBSTRATE_ROOT: path.join(checkout, 'substrate'), GOLEM_ROLES_DIR: path.join(checkout, 'substrate', 'roles'),
    GOLEM_TRACKER_DB: path.join(dirs.GOLEM_HOME!, 'tracker.db'), GOLEM_ASSETS_DIR: path.join(dirs.GOLEM_HOME!, 'ticket-assets'),
    GOLEM_TYPED_DELIVERY_TOMBSTONES_DB: path.join(dirs.GOLEM_HOME!, 'typed-delivery-tombstones.db'),
  });
  // Native sessions remain allocated per project. Do not pin every project to
  // one profile-wide session/socket: herdr 0.9.1 derives those under
  // XDG_CONFIG_HOME/herdr/sessions/<allocated handle> (session.rs:160–193).
  for (const key of ['GOLEM_HERDR_SESSION', 'HERDR_SESSION', 'HERDR_SOCKET_PATH', 'HERDR_CLIENT_SOCKET_PATH', 'HERDR_CONFIG_PATH', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID',
    'GOLEM_SESSION_ID', 'GOLEM_CEO_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'CLAUDE_PLUGIN_ROOT', 'GOLEM_RENDER_ROOT']) delete env[key];
  return profile;
}

export async function assertPortBlockFree(port: number): Promise<void> {
  const listeners: net.Server[] = [];
  try {
    for (const p of [port, port + 1, port + 2]) {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', () => reject(new Error(`profile port ${p} is occupied or unavailable`)));
        server.listen(p, '127.0.0.1', resolve);
      });
      listeners.push(server);
    }
  } finally { await Promise.all(listeners.map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
}

export async function runBootstrap(): Promise<void> {
  const args = process.argv.slice(2);
  const profile = resolveProfile(args);
  process.argv = [process.argv[0]!, process.argv[1]!, ...args];
  if (process.env.GOLEM_PROFILE && args[0] === 'migrate-home' && !args.includes('--help') && !args.includes('-h')) throw new Error('migrate-home is production-only; profiles already own isolated state');
  if (profile && ['dev', 'dashboard'].includes(args[0]!) && !args.includes('--help') && !args.includes('-h')) await assertPortBlockFree(profile.port);
  if (args[0] === 'dev') {
    if (!profile) throw new Error('golem dev requires --profile <name>');
    const { runDev } = await import('./dev.js');
    await runDev(args.slice(1));
  } else await import('./golem.js');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBootstrap().catch(error => { console.error(`golem: ${error.message}`); process.exitCode = 2; });
}
