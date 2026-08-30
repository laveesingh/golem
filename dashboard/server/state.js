// Owns in-memory dashboard state for ALL projects (v4 only).
//
// v4 state surface:
//   - Discovered projects + PLAN.md progress per project.
//   - Native Claude Code sessions on this machine.
//   - Live channel registrations (for brief/interrupt routing).
//   - Cross-project milestone feed from the central journal.
//
// What was removed with the v3 journal-agent pipeline:
//   - per-project journal stores and synthesized agents
//   - markdown tracker/ tickets
//   - v3 orchestrator snapshot, gates, CEO session registry
//
// Event taxonomy emitted to listeners:
//   { type: 'project-update', project }
//   { type: 'projects-list',  projects }
//   { type: 'native-sessions-update', native_sessions, channels }

import { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar from 'chokidar';
import { CONFIG } from './config.js';
import { discoverProjects } from './projects.js';
import { readPlan } from './plan.js';
import { readNativeSessions } from './native-sessions.js';
import { readChannels } from './channels.js';
import { readProjectMilestones } from './milestones.js';
import { updateProjectLsp } from '../../lib/lsp.js';

export function createState() {
  const ee = new EventEmitter();
  ee.setMaxListeners(64);

  /** @type {Array} */
  let projects = [];
  /** @type {Map<string, any>} */
  const projectsById = new Map();
  /** @type {Map<string, {title,total,done,items}|null>} */
  const plans = new Map();
  /** @type {Map<string, Array<{t:number,text:string,session_id:string|null}>>} */
  const milestonesByProject = new Map();

  /** @type {any[]} */
  let nativeSessions = [];
  /** @type {any[]} */
  let channels = [];

  let watcher = null;
  let rediscoverTimer = null;
  let nativeSessionsTimer = null;
  const refreshTimers = new Map();
  const lspCheckedProjects = new Set();

  function projectSummary(p) {
    const plan = plans.get(p.id) ?? null;
    const milestones = milestonesByProject.get(p.id) ?? [];
    return {
      id: p.id,
      project_id: p.project_id ?? null,
      kind: p.kind,
      auto: !!p.auto,
      name: p.name,
      glyph: p.glyph,
      color: p.color,
      description: p.description,
      // TKT-0010: recency used for ordering and stale demotion.
      // TKT-0107: now derives from the composite last_activity_at (live
      // session heartbeat > ticket updated_at > journal mtime > git commit
      // > workspace mtime). Kept under both keys for backward compat.
      last_seen_at: p.last_activity_at ?? p.last_seen_at ?? 0,
      last_activity_at: p.last_activity_at ?? 0,
      stale: !!p.stale,
      // v4: PLAN.md progress (null when the project has no PLAN.md).
      plan: plan ? { title: plan.title, total: plan.total, done: plan.done, items: plan.items } : null,
      // v4: project-level milestone feed (primary progress signal).
      milestones,
      // Legacy gate-file read path retained for API/debug compatibility. New
      // gates are spec question comments; the dashboard no longer renders gates.
      gates: p.gates ?? [],
      // Keep the gate dir metadata for audit/debug callers.
      gatesDir: p.gatesDir ?? null,
      gatesCentral: !!p.gatesCentral,
    };
  }

  // v4: merge every project's milestone feed into one newest-first list,
  // stamped with the owning project's id / name / color / glyph.
  function recentMilestones(summaries, cap = 40) {
    const merged = [];
    for (const p of summaries) {
      for (const m of p.milestones ?? []) {
        merged.push({
          t: m.t,
          text: m.text,
          session_id: m.session_id ?? null,
          project: p.id,
          project_name: p.name,
          project_color: p.color,
          project_glyph: p.glyph,
        });
      }
    }
    merged.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
    return merged.slice(0, cap);
  }

  function snapshot() {
    // The dashboard / substrate developer's primary workspace is the golem
    // repo root, registered with kind: 'root'. Include it alongside projects
    // and externals so the tracker / sidebar can find it. (TKT-0008 removed
    // the synthetic discoverRoot() but left the registry entry stranded.)
    const projectSummaries = projects
      .filter((p) => p.kind === 'project' || p.kind === 'external' || p.kind === 'root')
      .map(projectSummary);
    return {
      projects: projectSummaries,
      workspaces: projects.map(projectSummary),
      // v4: ALL Claude Code sessions on this machine.
      native_sessions: nativeSessions,
      // v4: live channel registrations.
      channels,
      // v4: cross-project milestone feed (primary progress signal), newest first.
      recent_milestones: recentMilestones(projectSummaries),
    };
  }

  function projectPlan(projectId) {
    return plans.get(projectId) ?? null;
  }

  // Resolve the FULL internal project record (with `path`) by either the
  // registry `id` (dir name, e.g. "trialroom-ai") OR the contract `project_id`
  // (<slug>-<6hex>, e.g. "trialroomai-74ac11"). The web UI sends the contract
  // project_id, which is NOT the projectsById key; callers that need the full
  // record must not fall back to pathless summaries.
  function project(id) {
    return projectsById.get(id) ?? projects.find((p) => p.project_id === id) ?? null;
  }

  // v4: decide whether a native session belongs to a registered project.
  function registeredIdForPath(rootPath, cwd) {
    for (const p of projects) {
      if (rootPath && p.path === rootPath) return p.id;
    }
    if (cwd) {
      for (const p of projects) {
        if (cwd === p.path || cwd.startsWith(p.path + path.sep)) return p.id;
      }
    }
    return null;
  }

  async function refreshPlan(projectId) {
    const p = projectsById.get(projectId);
    if (!p) return;
    plans.set(projectId, await readPlan(p.path));
    ee.emit('event', { type: 'project-update', project: projectSummary(p) });
  }

  async function refreshMilestones(projectId) {
    const p = projectsById.get(projectId);
    if (!p) return;
    const ms = await readProjectMilestones(p);
    milestonesByProject.set(projectId, ms);
    ee.emit('event', { type: 'project-update', project: projectSummary(p) });
  }

  // GOL-39: dedupe concurrent refreshes. Every /api/sessions/dispatchable call
  // refreshes synchronously, and a spawn-wait polls that endpoint every second
  // while the dashboard's own 3s tick refreshes too. Each refresh spawns the
  // `claude agents --json` subprocess and probes every endpoint lease — the
  // piled-up concurrent refreshes saturated the dashboard and starved worker
  // registrations ("This operation was aborted"). Share one in-flight refresh
  // and serve callers from a 1s-fresh result instead.
  let nativeRefreshInFlight = null;
  let nativeRefreshedAt = 0;
  const NATIVE_REFRESH_MIN_INTERVAL_MS = 250;

  async function refreshNativeSessions() {
    if (nativeRefreshInFlight) return nativeRefreshInFlight;
    if (Date.now() - nativeRefreshedAt < NATIVE_REFRESH_MIN_INTERVAL_MS) return;
    nativeRefreshInFlight = (async () => {
      try {
        const chans = await readChannels().catch(() => []);
        const sessions = await readNativeSessions(registeredIdForPath, chans);
        nativeSessions = sessions;
        channels = Array.isArray(chans) ? chans : [];
        // TKT-0266: persist durable session-name labels. Keyed off nativeSessions
        // (NOT dispatchable) — a named session without a channel still deserves a
        // persisted name. Only alive sessions with a name are upserted; the upsert
        // is change-gated + 5-min staleness-gated internally so this 3s tick does
        // NOT write a row every tick for every session.
        if (trackerRef && typeof trackerRef.upsertSessionLabel === 'function') {
          for (const s of nativeSessions) {
            if (!s.alive || !s.name || !s.session_id) continue;
            try {
              trackerRef.upsertSessionLabel(s.session_id, s.name, s.project_id ?? null);
            } catch (err) {
              console.error('[native-sessions] upsertSessionLabel failed:', err);
            }
          }
        }
        ee.emit('event', {
          type: 'native-sessions-update',
          native_sessions: nativeSessions,
          channels,
        });
      } catch (err) {
        console.error('[native-sessions]', err);
      } finally {
        nativeRefreshedAt = Date.now();
        nativeRefreshInFlight = null;
      }
    })();
    return nativeRefreshInFlight;
  }

  function debouncedRefresh(key, fn, delay = 80) {
    const existing = refreshTimers.get(key);
    if (existing) clearTimeout(existing);
    refreshTimers.set(
      key,
      setTimeout(() => {
        refreshTimers.delete(key);
        fn().catch((err) => console.error(`[refresh:${key}]`, err));
      }, delay),
    );
  }

  function watchedPaths() {
    const paths = [];
    for (const p of projects) {
      if ((p.kind === 'project' || p.kind === 'external')) {
        // v4: watch PLAN.md so the progress bar updates live.
        if (p.planFile) paths.push(p.planFile);
        // v4: watch central/legacy journal files so the milestone feed updates live.
        if (p.hookFile) paths.push(p.hookFile);
        if (p.summaryFile) paths.push(p.summaryFile);
      }
    }
    return paths;
  }

  async function rediscover() {
    const next = await discoverProjects({ tracker: trackerRef, nativeSessions });
    const nextIds = new Set(next.map((p) => p.id));
    const prevIds = new Set(projects.map((p) => p.id));

    // Remove projects that disappeared.
    for (const id of prevIds) {
      if (!nextIds.has(id)) {
        plans.delete(id);
        milestonesByProject.delete(id);
        projectsById.delete(id);
      }
    }

    // Read PLAN.md + milestones for every project (new ones only to avoid
    // clobbering a fresher chokidar read).
    for (const p of next) {
      if (!prevIds.has(p.id)) {
        plans.set(p.id, await readPlan(p.path));
        milestonesByProject.set(p.id, await readProjectMilestones(p));
      }
      if (p.path && !lspCheckedProjects.has(p.id)) {
        lspCheckedProjects.add(p.id);
        updateProjectLsp(p.path).catch((err) => console.error(`[lsp:${p.id}]`, err));
      }
      projectsById.set(p.id, p);
    }
    projects = next;

    // Re-attach the watcher so newly-added/removed files are observed.
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
    watcher = chokidar.watch(watchedPaths(), {
      persistent: true,
      ignoreInitial: true,
      // Journal files see lots of appends; smooth them out.
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 40 },
    });

    watcher
      .on('add', onProjectFileChange)
      .on('change', onProjectFileChange)
      .on('unlink', onProjectFileChange)
      .on('error', (err) => console.error('[watcher]', err));

    ee.emit('event', { type: 'projects-list', projects: projects.map(projectSummary) });
  }

  function onProjectFileChange(filePath) {
    for (const p of projects) {
      if ((p.kind === 'project' || p.kind === 'external')) {
        if (p.planFile && filePath === p.planFile) {
          debouncedRefresh(`plan:${p.id}`, () => refreshPlan(p.id));
          return;
        }
        if ((p.hookFile && filePath === p.hookFile) || (p.summaryFile && filePath === p.summaryFile)) {
          debouncedRefresh(`milestones:${p.id}`, () => refreshMilestones(p.id));
          return;
        }
      }
    }
  }

  // TKT-0107: tracker reference is set by main() before init() runs. We keep
  // it as a closure variable rather than a module export so dashboard server
  // keeps single-owner semantics on the DB connection.
  let trackerRef = null;

  async function init(tracker = null) {
    trackerRef = tracker;
    await rediscover();
    await refreshNativeSessions();

    // Periodic rediscovery catches new projects added after the dashboard starts.
    rediscoverTimer = setInterval(() => {
      rediscover().catch((err) => console.error('[rediscover]', err));
    }, 30_000);

    // Native session + channel liveness is poll-based.
    nativeSessionsTimer = setInterval(() => {
      refreshNativeSessions();
    }, 3_000);
  }

  async function close() {
    if (watcher) await watcher.close();
    if (rediscoverTimer) clearInterval(rediscoverTimer);
    if (nativeSessionsTimer) clearInterval(nativeSessionsTimer);
    for (const t of refreshTimers.values()) clearTimeout(t);
    refreshTimers.clear();
  }

  return {
    init,
    close,
    on: (...args) => ee.on(...args),
    off: (...args) => ee.off(...args),
    snapshot,
    projects: () => projects.filter((p) => (p.kind === 'project' || p.kind === 'external')).map(projectSummary),
    workspaces: () => projects.map(projectSummary),
    project,
    projectPlan,
    nativeSessions: () => nativeSessions,
    refreshNativeSessions,
    channels: () => channels,
  };
}
