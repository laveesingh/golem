// Test-only prerequisite planning. Never read/copy credential contents or provision auth.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const incomplete = message => { throw new Error(`INCOMPLETE: ${message}; provision and explicitly authorize a dedicated private actor facility before running`); };
const within = (value, parent) => value === parent || value.startsWith(`${parent}${path.sep}`);
export function createRealJourneyResources(plan, { tempParent=os.tmpdir(), xdgParent='/tmp' }={}) {
  const parents=[fs.realpathSync(tempParent),fs.realpathSync(xdgParent)];
  for(const facility of Object.values(plan.facilities)) {
    const directory=fs.realpathSync(facility.directory);
    if(parents.some(parent=>within(parent,directory))) incomplete('supplied facility overlaps a resource allocation parent');
  }
  // mkdtemp exclusively creates BOTH roots. Never borrow a reusable PID path.
  const root=fs.realpathSync(fs.mkdtempSync(path.join(parents[0],'golemtest-management-real-')));
  let xdg;
  try { xdg=fs.realpathSync(fs.mkdtempSync(path.join(parents[1],'gr-'))); }
  catch(error) { fs.rmSync(root,{recursive:true,force:true});throw error; }
  const owned=[root,xdg].map(directory=>({directory,stat:fs.lstatSync(directory)}));
  return {root,xdg,cleanup:()=>{
    // Refuse ALL deletion if ownership or supplied-facility separation changed.
    for(const entry of owned) {
      const current=fs.lstatSync(entry.directory);
      if(current.isSymbolicLink() || current.ino!==entry.stat.ino || current.dev!==entry.stat.dev) incomplete('resource cleanup ownership changed');
      for(const facility of Object.values(plan.facilities)) {
        const supplied=fs.realpathSync(facility.directory);
        if(within(supplied,entry.directory)||within(entry.directory,supplied)) incomplete('supplied facility overlaps resource cleanup');
      }
    }
    for(const entry of owned) fs.rmSync(entry.directory,{recursive:true,force:true});
  }};
}
export function realActorEnvironment(source) {
  // Allow only OS/terminal necessities. Do not inherit provider credentials,
  // credential helpers, live config overrides or arbitrary model env keys.
  const keys=['PATH','TERM','COLORTERM','LANG','LC_ALL','LC_CTYPE','TZ','TMPDIR','SystemRoot','ComSpec','PATHEXT'];
  return Object.fromEntries(keys.filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));
}
export function selectRealActors(env) {
  const actors = env.GOLEM_REAL_ACTORS === undefined ? ['pi','claude'] : env.GOLEM_REAL_ACTORS.split(',');
  if (!actors.length || actors.some(a => !['pi','claude'].includes(a)) || new Set(actors).size !== actors.length) incomplete('GOLEM_REAL_ACTORS must select pi, claude, or pi,claude without duplicates');
  return actors;
}
export function planRealActorSetup(env) {
  const actors = selectRealActors(env); // Must precede every resource/facility operation.
  const facilities = {};
  for (const actor of actors) {
    const key = actor === 'pi' ? 'GOLEM_REAL_PI_AGENT_DIR' : 'GOLEM_REAL_CLAUDE_CONFIG_DIR';
    const directory = env[key];
    if (!directory || !path.isAbsolute(directory)) incomplete(`${actor} requires an explicit absolute ${key}`);
    facilities[actor] = { directory: path.normalize(directory), key };
  }
  if (actors.includes('pi')) {
    if (!env.GOLEM_REAL_HERDR_PI_REPORTER || !path.isAbsolute(env.GOLEM_REAL_HERDR_PI_REPORTER)) incomplete('pi requires the explicit existing Herdr reporter path GOLEM_REAL_HERDR_PI_REPORTER');
    facilities.pi.reporter = env.GOLEM_REAL_HERDR_PI_REPORTER;
  }
  const liveRoots = env.HOME ? [path.resolve(env.HOME), path.resolve(env.HOME,'.pi'), path.resolve(env.HOME,'.claude')] : [];
  for (const facility of Object.values(facilities)) {
    if (liveRoots.some(root => facility.directory === root) || liveRoots.slice(1).some(root => within(facility.directory,root))) incomplete(`${facility.key} cannot reuse the live HOME/default configuration`);
  }
  return { actors, facilities, liveRoots };
}
export function verifyRealActorSetup(plan, io = fs) {
  // Metadata only, and only selected facilities; no auth/config file discovery.
  let resolvedHome=plan.liveRoots[0]; try { if(resolvedHome) resolvedHome=io.realpathSync(resolvedHome); } catch {}
  const liveRoots = [...plan.liveRoots,...(resolvedHome?[resolvedHome,path.join(resolvedHome,'.pi'),path.join(resolvedHome,'.claude')]:[])];
  for (const facility of Object.values(plan.facilities)) {
    let directory;
    try { directory=io.realpathSync(facility.directory); }
    catch { incomplete(`${facility.key} is not an available private directory`); }
    if(liveRoots.some(root => directory === root) || liveRoots.filter(root=>root!==plan.liveRoots[0] && root!==resolvedHome).some(root => within(directory,root))) incomplete(`${facility.key} resolves to live HOME/default configuration`);
    try { if(!io.statSync(directory).isDirectory()) incomplete(`${facility.key} is not a directory`); } catch { incomplete(`${facility.key} is not an available private directory`); }
    facility.directory=directory;
    if(facility.reporter) { try { if(!io.statSync(facility.reporter).isFile()) incomplete('Herdr Pi reporter is not a file'); } catch { incomplete('explicit Herdr Pi reporter is unavailable'); } }
  }
  return plan;
}
