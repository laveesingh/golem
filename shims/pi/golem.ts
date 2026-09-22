import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { golemHome } from './lib/golem-home.js';
import { dashboardJsonPath } from './lib/golem-home.js';
import { createGolemClient, resolveGolemDashboardBaseUrl } from './lib/golem-client.js';
import { GOLEM_TOOL_CONTRACTS } from './lib/golem-tool-contracts.js';
import { createGolemToolRuntime } from './lib/golem-tool-runtime.js';
import { PiNativeAdapter } from './lib/pi-native-adapter.js';
import { readRoleCard, sessionsJsonPath, setSessionRole, validateSessionRole } from './lib/session-role.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PI_ROLES = new Set(['builder', 'explorer', 'reviewer', 'lead']);

function formatTokens(count) {
  if (count == null) return '?';
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function compactCwd(cwd) {
  const resolved = path.resolve(cwd);
  const current = path.basename(resolved);
  if (!current) return path.parse(resolved).root;
  const parentPath = path.dirname(resolved);
  const parent = path.basename(parentPath);
  return parent ? `${parent}${path.sep}${current}` : current;
}

function usageTotals(sessionManager) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHit: null };
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const usage = entry.message.usage || {};
    totals.input += usage.input || 0;
    totals.output += usage.output || 0;
    totals.cacheRead += usage.cacheRead || 0;
    totals.cacheWrite += usage.cacheWrite || 0;
    totals.cost += usage.cost?.total || 0;
    const prompt = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
    totals.cacheHit = prompt > 0 ? ((usage.cacheRead || 0) / prompt) * 100 : totals.cacheHit;
  }
  return totals;
}

function lastTurnEndTime(sessionManager) {
  const entries = sessionManager?.getEntries() || [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      const ts = entry.timestamp || entry.message?.timestamp;
      if (ts) {
        const d = new Date(ts);
        if (!isNaN(d.getTime())) return d;
      }
    }
  }
  return null;
}

function formatTurnTiming(lastTurn) {
  if (!lastTurn) return null;
  const now = Date.now();
  const diffSecs = Math.max(0, Math.floor((now - lastTurn.getTime()) / 1000));
  const hrs = Math.floor(diffSecs / 3600);
  const mins = Math.floor((diffSecs % 3600) / 60);
  const ago = hrs >= 1 ? `${hrs}h${mins}m` : `${mins}m`;

  const hh = String(lastTurn.getHours()).padStart(2, '0');
  const mm = String(lastTurn.getMinutes()).padStart(2, '0');
  const ended = `${hh}:${mm}`;

  // For cloud models (ollama-cloud, antigravity, zai, xai),
  // cache is typically warm within ~10 minutes
  const isWarm = diffSecs < 600;
  const badge = isWarm ? '🔥' : '❄️';
  return `${badge}${ended}(${ago})`;
}

function contextMeter(ctx, theme) {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow || ctx.model?.contextWindow || 0;
  const percent = usage?.percent;
  const bounded = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const exactCells = bounded / 10;
  let filled = Math.floor(exactCells);
  let partialIndex = Math.round((exactCells - filled) * 8);
  if (partialIndex === 8) {
    filled += 1;
    partialIndex = 0;
  }
  const partial = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'][partialIndex];
  const bar = `${'█'.repeat(filled)}${partial}${'░'.repeat(10 - filled - (partial ? 1 : 0))}`;
  const color = bounded > 90 ? 'error' : bounded >= 70 ? 'warning' : 'accent';
  const percentage = percent == null ? '?' : `${percent.toFixed(1)}%`;
  return `${theme.fg(color, bar)} ${percentage} ${formatTokens(usage?.tokens)}/${formatTokens(contextWindow)}`;
}

function installFooter(pi) {
  let activeTui;
  let currentCtx = null;
  let disposeFooter = null;
  let renderTimer = null;

  pi.on('session_info_changed', () => activeTui?.requestRender());

  // Session replacement (new/fork/switch/reload) invalidates the captured ctx.
  // Drop it and dispose the footer so no render touches the stale ctx.
  pi.on('session_shutdown', () => {
    if (renderTimer) clearInterval(renderTimer);
    renderTimer = null;
    currentCtx = null;
    disposeFooter?.();
    disposeFooter = null;
    activeTui = undefined;
  });

  pi.on('session_start', (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.mode !== 'tui' || !ctx.ui?.setFooter) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      if (renderTimer) clearInterval(renderTimer);
      renderTimer = setInterval(() => {
        if (activeTui) activeTui.requestRender();
      }, 30000);
      disposeFooter = () => {
        unsubscribe();
        if (renderTimer) clearInterval(renderTimer);
        renderTimer = null;
        if (activeTui === tui) activeTui = undefined;
      };
      return {
        dispose() {
          disposeFooter?.();
          disposeFooter = null;
        },
        invalidate() {},
        render(width) {
          const c = currentCtx;
          if (!c) return [];
          try {
            const branch = footerData.getGitBranch();
            const sessionName = c.sessionManager.getSessionName();
            const cwd = theme.bold(theme.fg('accent', compactCwd(c.cwd)));
            const branchText = branch ? theme.fg('muted', ` (${branch})`) : '';
            const sessionText = sessionName ? ` ${theme.fg('dim', '•')} ${theme.bold(theme.fg('accent', sessionName))}` : '';
            const identity = truncateToWidth(`${cwd}${branchText}${sessionText}`, width, '…');

            const totals = usageTotals(c.sessionManager);
            const lastTurn = lastTurnEndTime(c.sessionManager);
            const turnTiming = formatTurnTiming(lastTurn);

            const stats = [];
            if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
            if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
            if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
            if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
            if (totals.cacheHit != null && (totals.cacheRead || totals.cacheWrite)) stats.push(`CH${totals.cacheHit.toFixed(1)}%`);
            if (totals.cost) stats.push(`$${totals.cost.toFixed(3)}`);
            if (turnTiming) stats.push(turnTiming);
            const left = `${theme.fg('muted', stats.join(' '))}${stats.length ? ' ' : ''}${contextMeter(c, theme)}`;

            const model = c.model?.id || 'no-model';
            const provider = footerData.getAvailableProviderCount() > 1 && c.model ? `(${c.model.provider}) ` : '';
            const thinking = c.model?.reasoning ? ` • ${pi.getThinkingLevel()}` : '';
            const fullRight = theme.fg('muted', `${provider}${model}${thinking}`);
            const fallbackRight = theme.fg('muted', `${model}${thinking}`);
            let right = fullRight;
            if (visibleWidth(left) + 2 + visibleWidth(fullRight) > width) right = fallbackRight;
            const rightBudget = width >= 40 ? Math.min(visibleWidth(right), Math.max(0, width - 22)) : 0;
            const leftBudget = Math.max(0, width - rightBudget - (rightBudget ? 2 : 0));
            const fittedLeft = truncateToWidth(left, leftBudget, '…');
            const fittedRight = rightBudget ? truncateToWidth(right, rightBudget, '…') : '';
            const gap = Math.max(0, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
            const metrics = `${fittedLeft}${' '.repeat(gap)}${fittedRight}`;

            const lines = [identity, metrics];
            const statuses = [...footerData.getExtensionStatuses().entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => String(text).replace(/[\r\n\t]+/g, ' ').trim())
              .filter(Boolean);
            if (statuses.length) lines.push(truncateToWidth(statuses.join(' '), width, '…'));
            return lines;
          } catch {
            // Stale ctx guard after session replacement: degrade to an empty
            // footer instead of crashing the session.
            return [];
          }
        },
      };
    });
  });
}

function sessionRole(sessionId) {
  try {
    const value = JSON.parse(fs.readFileSync(sessionsJsonPath(), 'utf8'));
    return value.sessions?.find((row) => row.session_id === sessionId)?.role ?? null;
  } catch { return null; }
}

function projectContext(sessionId, cwd) {
  const script = path.join(ROOT, 'hooks', 'tracker-context.sh');
  const out = execFileSync('bash', [script], {
    cwd, encoding: 'utf8', input: JSON.stringify({ session_id: sessionId, cwd }),
    stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000,
  });
  return JSON.parse(out)?.hookSpecificOutput?.additionalContext?.trim() || '(no project context available)';
}

function toolText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length <= 30_000 ? text : `${text.slice(0, 30_000)}\n… output truncated by Golem`;
}

// Pi-specific primitive binding. Shared transport, lifecycle, replay, facts,
// leases, and journaling live in the rendered runtime modules.
export default function golem(pi) {
  installFooter(pi);
  const adapter = new PiNativeAdapter(pi);
  adapter.bind();

  // GOL-365: the full shared contract list is the only tool surface; returns
  // and recipient discovery go through the golem CLI per golem:team-ops.
  for (const contract of GOLEM_TOOL_CONTRACTS) {
    pi.registerTool({
      name: contract.name,
      label: contract.name,
      description: contract.description,
      parameters: contract.inputSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const sessionId = adapter.canonicalId || ctx.sessionManager.getSessionId();
          const client = createGolemClient({
            baseUrl: resolveGolemDashboardBaseUrl({ dashboardFile: dashboardJsonPath() }),
            callerSessionId: sessionId,
          });
          const runtime = createGolemToolRuntime({
            client,
            callerSessionId: sessionId,
            projectId: adapter.projectId,
            acknowledge: ({ envelope_id, ...body }) => {
              if (!envelope_id) return { ok: true, skipped: true, reason: 'uncorrelated acknowledgement has no durable envelope' };
              return client.acknowledgeEnvelope(envelope_id, body);
            },
            setRole: ({ role }) => {
              validateSessionRole(role);
              return setSessionRole(sessionId, role, { by: 'self:mcp' });
            },
            projectContext: () => projectContext(sessionId, ctx.cwd),
          });
          const result = await runtime.invoke(contract.name, params || {});
          return { content: [{ type: 'text', text: toolText(result) }], details: { ok: true, result } };
        } catch (error) {
          const detail = typeof error?.toJSON === 'function' ? error.toJSON() : { name: error?.name || 'Error', message: error?.message || String(error) };
          return { content: [{ type: 'text', text: toolText(detail) }], details: { ok: false, error: detail }, isError: true };
        }
      },
    });
  }

  pi.on('resources_discover', () => ({ skillPaths: [path.join(ROOT, 'skills')] }));
  pi.on('before_agent_start', (event, ctx) => {
    const sessionId = adapter.canonicalId || ctx.sessionManager.getSessionId();
    const role = sessionRole(sessionId);
    const instructions = fs.readFileSync(path.join(ROOT, 'instructions', 'AGENTS.md'), 'utf8').trim();
    // No role assigned means lead (Global Rules § First, every session).
    const roleCard = readRoleCard(PI_ROLES.has(role) ? role : 'lead');
    let ambient = '';
    try { ambient = projectContext(sessionId, ctx.cwd); } catch {}
    const boundary = 'Pi integration: follow the assigned role card, not every role supported by this harness. Golem teammates are separate sessions managed through golem CLI and team tools; Pi-native in-session subagents are unavailable.';
    return { systemPrompt: [event.systemPrompt, instructions, boundary, roleCard, ambient].filter(Boolean).join('\n\n') };
  });

  // Migration-only reader for records published by the former Tier-B adapter.
  // First-class typed dispatch never writes this spool; keep already-published
  // records recoverable until the dashboard cutover proves it empty.
  const home = golemHome();
  let canonicalId;
  let pendingPickup = [];
  pi.on('session_start', (_event, ctx) => {
    canonicalId = ctx.sessionManager.getSessionId();
  });
  pi.on('input', (event, ctx) => {
    if (event.source === 'extension') return;
    const id = canonicalId || ctx.sessionManager.getSessionId();
    const root = path.join(home, 'pi-inbox', id);
    const pending = path.join(root, 'pending');
    const processingDir = path.join(root, 'processing');
    const work = [
      ...(fs.existsSync(processingDir) ? fs.readdirSync(processingDir).sort().map((name) => ({ name, source: path.join(processingDir, name), claimed: true })) : []),
      ...(fs.existsSync(pending) ? fs.readdirSync(pending).sort().map((name) => ({ name, source: path.join(pending, name), claimed: false })) : []),
    ];
    const messages = [];
    for (const item of work) {
      const processing = path.join(root, 'processing', item.name);
      try {
        fs.mkdirSync(path.dirname(processing), { recursive: true });
        if (!item.claimed) fs.renameSync(item.source, processing);
        const value = JSON.parse(fs.readFileSync(processing, 'utf8'));
        if (typeof value?.text !== 'string') throw new Error('invalid text');
        messages.push(value);
        pendingPickup.push({ root, name: item.name });
      } catch {
        try {
          fs.mkdirSync(path.join(root, 'dead-letter'), { recursive: true });
          fs.renameSync(processing, path.join(root, 'dead-letter', item.name));
        } catch {}
      }
    }
    if (messages.length) return { action: 'transform', text: `${event.text}\n\n${messages.map((item) => item.text).join('\n\n')}` };
  });
  pi.on('agent_start', () => {
    for (const { root, name } of pendingPickup) {
      try {
        fs.mkdirSync(path.join(root, 'acks'), { recursive: true });
        fs.renameSync(path.join(root, 'processing', name), path.join(root, 'acks', name));
      } catch {}
    }
    pendingPickup = [];
  });
}
