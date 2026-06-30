// Tracker data layer — a NEW SQLite database the dashboard server owns.
//
// This is the cross-project ticket tracker's storage. It supersedes the
// legacy read-only markdown reader in tracker.js (which WS2 will keep around
// for back-compat). Everything here is synchronous (better-sqlite3); the
// dashboard's request handlers are async but the DB calls inside them are not.
//
// DB path resolution mirrors how the rest of the codebase finds the golem
// config dir (see orchestrator.js): XDG_CONFIG_HOME ?? ~/.config, then /golem.
// The file is tracker.db inside that dir, overridable wholesale via
// GOLEM_TRACKER_DB.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm as turndownGfm } from 'turndown-plugin-gfm';

const SCHEMA_VERSION = 5;

const KINDS = new Set(['work-item', 'decision', 'spec', 'question', 'fix']);
const STATES = new Set(['todo', 'in_progress', 'blocked', 'review', 'done', 'archived']);
const STREAM_MODES = new Set(['sequential', 'parallel']);
const LINK_TYPES = new Set(['blocks', 'relates', 'duplicates']);
const COMMENT_TAGS = new Set(['confirmed', 'partial', 'disputed', 'fix', 'risk', 'question', 'note']);

const HOME = os.homedir();

function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'), 'golem');
}

/** Default DB path: <golem config dir>/tracker.db, overridable by GOLEM_TRACKER_DB. */
export function defaultDbPath() {
  return process.env.GOLEM_TRACKER_DB ?? path.join(configDir(), 'tracker.db');
}

function now() {
  return new Date().toISOString();
}

function parseLabels(raw) {
  if (raw == null) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function serializeLabels(labels) {
  if (labels == null) return '[]';
  if (typeof labels === 'string') {
    // Already a JSON array string? keep it; otherwise wrap a single label.
    const parsed = parseLabels(labels);
    return JSON.stringify(parsed.length ? parsed : []);
  }
  return JSON.stringify(Array.isArray(labels) ? labels : []);
}

/**
 * Detect text that is probably Markdown (headings, lists, blockquotes, links,
 * fenced code, emphasis). Used to decide whether to run marked on plain text.
 */
function looksLikeMarkdown(text) {
  if (!text) return false;
  // Headings, lists, blockquotes, numbered lists at line start.
  if (/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|\>\s|```)/m.test(text)) return true;
  // Inline / block markdown patterns.
  if (/\[([^\]]+)\]\(([^)]+)\)/.test(text)) return true; // links
  if (/!\[([^\]]*)\]\(([^)]+)\)/.test(text)) return true; // images
  if (/```[\s\S]*```/.test(text)) return true; // fenced code
  if (/\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`/.test(text)) return true; // bold/italic/strike/code
  return false;
}

/**
 * Normalize a ticket/comment body to canonical HTML.
 * - Existing HTML (starts with a tag) passes through.
 * - Markdown-looking plain text is converted via marked.
 * - Otherwise plain text is split into paragraphs (blank-line separated) with
 *   single newlines preserved as <br/>.
 * This lets agents continue to send plain text or Markdown while the UI always
 * renders HTML.
 */
function toHtmlBody(raw) {
  if (raw == null) return '';
  const text = String(raw).trim();
  if (!text) return '';
  // Heuristic: if it starts with an HTML tag, treat as HTML.
  if (/^\s*<[a-zA-Z][^>]*>/.test(text)) return text;
  if (looksLikeMarkdown(text)) {
    return marked(text, { gfm: true, breaks: false, headerIds: false, mangle: false });
  }
  return text
    .split(/\n\n+/)
    .map((p) => `<p>${p.trim().replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

/**
 * Normalize a ticket/comment body for verbatim Markdown storage (TKT-0170, v5).
 * Trim and collapse 3+ consecutive blank lines to 2. No HTML conversion and no
 * markdown->html — the body is stored as Markdown and rendered client-side (see
 * dashboard/web/src/format.js renderMarkdown). Legacy HTML-first bodies were
 * converted to Markdown once by the v4->v5 backfill migration in migrate().
 */
function toMarkdownBody(raw) {
  if (raw == null) return '';
  return String(raw).trim().replace(/\n{3,}/g, '\n\n');
}

// Hydrate a raw ticket row into a plain object with labels parsed to an array.
function hydrateTicket(row) {
  if (!row) return null;
  return { ...row, labels: parseLabels(row.labels) };
}

/**
 * Open (and migrate) the tracker DB.
 * @param {string} [dbPath] defaults to defaultDbPath()
 * @returns the data-access object documented in the WS1 spec.
 */
export function openTrackerDb(dbPath = defaultDbPath()) {
  // Ensure the parent dir exists for a file-backed DB (skip for :memory:).
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  function migrate() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id            TEXT PRIMARY KEY,
        seq           INTEGER NOT NULL,
        project_id    TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'work-item',
        title         TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        state         TEXT NOT NULL DEFAULT 'todo',
        priority      TEXT,
        labels        TEXT NOT NULL DEFAULT '[]',
        stream_id     TEXT,
        parent_id     TEXT,
        assignee      TEXT,
        created_by    TEXT NOT NULL DEFAULT 'human',
        dispatched_to TEXT,
        dispatched_at TEXT,
        source_ref    TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        -- TKT-0105 (v4 schema): lifecycle columns for rank ordering and
        -- the 14-day done→archived auto-archive sweep.
        rank              INTEGER NOT NULL DEFAULT 0,
        state_changed_at  TEXT,
        done_at           TEXT,
        archived_at       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_project  ON tickets(project_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_state    ON tickets(state);
      CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee);
      -- The two indexes that depend on lifecycle columns (state_rank, done_at)
      -- are created LATER in the migration block, AFTER the ALTER TABLE that
      -- adds those columns to pre-existing DBs. Doing them here would fail on
      -- any DB that pre-dates v4 because the columns don't exist yet.

      CREATE TABLE IF NOT EXISTS comments (
        id          TEXT PRIMARY KEY,
        ticket_id   TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        author      TEXT NOT NULL,
        body        TEXT NOT NULL,
        quote       TEXT,
        prefix      TEXT,
        suffix      TEXT,
        section     TEXT,
        section_id  TEXT,
        tag         TEXT NOT NULL DEFAULT 'note',
        status      TEXT NOT NULL DEFAULT 'open',
        parent_id   TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);

      CREATE TABLE IF NOT EXISTS streams (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        name        TEXT NOT NULL,
        mode        TEXT NOT NULL DEFAULT 'parallel',
        description TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_streams_project ON streams(project_id);

      CREATE TABLE IF NOT EXISTS links (
        from_ticket TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        to_ticket   TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        PRIMARY KEY (from_ticket, to_ticket, type)
      );

      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id  TEXT,
        project_id TEXT,
        type       TEXT NOT NULL,
        actor      TEXT,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ticket  ON events(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Seed meta defaults idempotently.
    const seed = db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)');
    seed.run('schema_version', String(SCHEMA_VERSION));
    seed.run('ticket_seq', '0');

    // Schema migration v1 -> v2: add annotation columns to comments.
    const columns = db.prepare("PRAGMA table_info(comments)").all().map((c) => c.name);
    const needed = ['quote', 'prefix', 'suffix', 'section', 'section_id', 'tag', 'status', 'parent_id', 'updated_at'];
    for (const col of needed) {
      if (!columns.includes(col)) {
        db.exec(`ALTER TABLE comments ADD COLUMN ${col} TEXT`);
      }
    }
    // tag/status have defaults; backfill any nulls from pre-v2 rows.
    db.prepare("UPDATE comments SET tag = COALESCE(tag, 'note'), status = COALESCE(status, 'open'), updated_at = COALESCE(updated_at, created_at) WHERE tag IS NULL OR status IS NULL OR updated_at IS NULL").run();

    // Schema migration v2 -> v3: canonical HTML bodies. Convert any ticket or
    // comment body that is not already HTML into HTML (Markdown -> HTML via
    // marked, plain text -> wrapped paragraphs).
    const schemaVersion = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value;
    if (schemaVersion && Number(schemaVersion) < 3) {
      const updateTicketBody = db.prepare('UPDATE tickets SET body = ?, updated_at = ? WHERE id = ?');
      for (const { id, body } of db.prepare('SELECT id, body FROM tickets').all()) {
        const html = toHtmlBody(body);
        if (html !== body) updateTicketBody.run(html, now(), id);
      }
      const updateCommentBody = db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?');
      for (const { id, body } of db.prepare('SELECT id, body FROM comments').all()) {
        const html = toHtmlBody(body);
        if (html !== body) updateCommentBody.run(html, now(), id);
      }
    }

    // Schema migration v3 -> v4 (TKT-0105): lifecycle columns. ALTER TABLE
    // adds them to existing rows (NULL by default). The backfill below writes
    // state_changed_at, done_at, archived_at, and rank so the new columns are
    // immediately useful (sortable by rank, sweep-able by done_at).
    const ticketCols = db.prepare("PRAGMA table_info(tickets)").all().map((c) => c.name);
    for (const [col, def] of [
      ['rank',             'INTEGER NOT NULL DEFAULT 0'],
      ['state_changed_at', 'TEXT'],
      ['done_at',          'TEXT'],
      ['archived_at',      'TEXT'],
    ]) {
      if (!ticketCols.includes(col)) {
        db.exec(`ALTER TABLE tickets ADD COLUMN ${col} ${def}`);
      }
    }
    // Backfill rank: seq * 1000 leaves gaps between sequential tickets so
    // manual reorders can drop cards between without rewriting every row.
    db.prepare(`UPDATE tickets SET rank = seq * 1000 WHERE rank = 0`).run();
    // state_changed_at from event rows where present; fall back to updated_at.
    db.prepare(`UPDATE tickets
SET state_changed_at = COALESCE(
  (SELECT MAX(e.created_at) FROM events e
     WHERE e.ticket_id = tickets.id AND e.type = 'state_change'),
  updated_at
)
WHERE state_changed_at IS NULL`).run();
    db.prepare(`UPDATE tickets SET done_at = state_changed_at
      WHERE state = 'done' AND done_at IS NULL`).run();
    db.prepare(`UPDATE tickets SET archived_at = state_changed_at
      WHERE state = 'archived' AND archived_at IS NULL`).run();

    // Schema migration v4 -> v5 (TKT-0170): Markdown-canonical bodies + a
    // block_id column for block-anchored comments. Convert every HTML-first
    // ticket/comment body (legacy "house-style" report) to Markdown via
    // turndown, keeping svg/figure/figcaption as raw-HTML blocks the client
    // renderer (format.js renderMarkdown) handles. <style>/<script> blocks are
    // stripped first so their text doesn't leak as stray paragraphs. Gated on
    // schema_version < 5 so it runs once and is idempotent across restarts.
    if (schemaVersion && Number(schemaVersion) < 5) {
      const commentCols = db.prepare("PRAGMA table_info(comments)").all().map((c) => c.name);
      if (!commentCols.includes('block_id')) {
        db.exec('ALTER TABLE comments ADD COLUMN block_id TEXT');
      }
      const td = new TurndownService();
      td.use(turndownGfm);
      td.keep(['svg', 'figure', 'figcaption']);
      const toMd = (html) => {
        const s = String(html ?? '').trim();
        if (!s || !/^\s*<[a-zA-Z][^>]*>/.test(s)) return html; // not HTML-first; leave as-is
        const stripped = s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').trim();
        return td.turndown(stripped).trim();
      };
      const updateTicketBody = db.prepare('UPDATE tickets SET body = ?, updated_at = ? WHERE id = ?');
      for (const { id, body } of db.prepare('SELECT id, body FROM tickets').all()) {
        const md = toMd(body);
        if (md !== body) updateTicketBody.run(md, now(), id);
      }
      const updateCommentBody = db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?');
      for (const { id, body } of db.prepare('SELECT id, body FROM comments').all()) {
        const md = toMd(body);
        if (md !== body) updateCommentBody.run(md, now(), id);
      }
    }

    // Indexes that depend on lifecycle columns. Idempotent: no-op on fresh
    // DBs (CREATE TABLE above already created them), first-time-create on
    // existing DBs (where the ALTER TABLE above just added the columns).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_state_rank ON tickets(state, rank)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_done_at ON tickets(done_at) WHERE done_at IS NOT NULL`);
    // Update schema_version to the current version (v5).
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
}

  // ---- prepared statements (built lazily after migrate) ----------------
  let stmts = null;
  function prepare() {
    stmts = {
      insertTicket: db.prepare(`
        INSERT INTO tickets
          (id, seq, project_id, kind, title, body, state, priority, labels,
           stream_id, parent_id, assignee, created_by, dispatched_to,
           dispatched_at, source_ref, created_at, updated_at)
        VALUES
          (@id, @seq, @project_id, @kind, @title, @body, @state, @priority, @labels,
           @stream_id, @parent_id, @assignee, @created_by, @dispatched_to,
           @dispatched_at, @source_ref, @created_at, @updated_at)
      `),
      getTicket: db.prepare('SELECT * FROM tickets WHERE id = ?'),
      getComments: db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC, id ASC'),
      insertComment: db.prepare(`
        INSERT INTO comments
          (id, ticket_id, author, body, quote, prefix, suffix, section, section_id,
           tag, status, parent_id, block_id, created_at, updated_at)
        VALUES
          (@id, @ticket_id, @author, @body, @quote, @prefix, @suffix, @section, @section_id,
           @tag, @status, @parent_id, @block_id, @created_at, @updated_at)
      `),
      touchTicket: db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?'),
      insertStream: db.prepare(`
        INSERT INTO streams (id, project_id, name, mode, description, created_at, updated_at)
        VALUES (@id, @project_id, @name, @mode, @description, @created_at, @updated_at)
      `),
      getStream: db.prepare('SELECT * FROM streams WHERE id = ?'),
      listStreams: db.prepare('SELECT * FROM streams WHERE project_id = ? ORDER BY created_at ASC, id ASC'),
      insertLink: db.prepare('INSERT OR IGNORE INTO links (from_ticket, to_ticket, type) VALUES (?, ?, ?)'),
      deleteLink: db.prepare('DELETE FROM links WHERE from_ticket = ? AND to_ticket = ? AND type = ?'),
      listLinks: db.prepare('SELECT * FROM links WHERE from_ticket = ? OR to_ticket = ? ORDER BY type ASC'),
      insertEvent: db.prepare(`
        INSERT INTO events (ticket_id, project_id, type, actor, data, created_at)
        VALUES (@ticket_id, @project_id, @type, @actor, @data, @created_at)
      `),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  // ---- internal helpers -------------------------------------------------

  // recordEvent — internal, also exported on the returned object. Persists one
  // event row; `data` is JSON-serialized.
  function recordEvent({ ticket_id = null, project_id = null, type, actor = null, data = {} } = {}) {
    if (!type) throw new Error('recordEvent: type is required');
    const row = {
      ticket_id,
      project_id,
      type,
      actor,
      data: typeof data === 'string' ? data : JSON.stringify(data ?? {}),
      created_at: now(),
    };
    const info = stmts.insertEvent.run(row);
    return { id: Number(info.lastInsertRowid), ...row, data: safeParse(row.data) };
  }

  function safeParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  }

  // allocateTicketId — bump the meta ticket_seq counter inside a transaction
  // and format the new id. Monotonic and collision-free under concurrent opens
  // because better-sqlite3 transactions serialize and busy_timeout retries.
  const allocateTxn = db.transaction(() => {
    const cur = Number(stmts.getMeta.get('ticket_seq')?.value ?? '0');
    const seq = cur + 1;
    stmts.setMeta.run('ticket_seq', String(seq));
    const id = `TKT-${String(seq).padStart(4, '0')}`;
    return { id, seq };
  });

  function allocateTicketId() {
    return allocateTxn();
  }

  // ---- public API -------------------------------------------------------

  const api = {
    init() {
      migrate();
      prepare();
      return api;
    },

    close() {
      db.close();
    },

    raw() {
      return db;
    },

    allocateTicketId,

    recordEvent,

    createTicket(input = {}) {
      const {
        project_id,
        kind = 'work-item',
        title,
        body = '',
        state = 'todo',
        priority = null,
        labels = [],
        stream_id = null,
        parent_id = null,
        assignee = null,
        created_by = 'human',
        source_ref = null,
      } = input;

      if (!project_id) throw new Error('createTicket: project_id is required');
      if (!title) throw new Error('createTicket: title is required');
      if (!KINDS.has(kind)) throw new Error(`createTicket: invalid kind '${kind}'`);
      if (!STATES.has(state)) throw new Error(`createTicket: invalid state '${state}'`);

      const ts = now();
      const bodyMd = toMarkdownBody(body);
      const txn = db.transaction(() => {
        const { id, seq } = allocateTicketId();
        const row = {
          id,
          seq,
          project_id,
          kind,
          title,
          body: bodyMd,
          state,
          priority,
          labels: serializeLabels(labels),
          stream_id,
          parent_id,
          assignee,
          created_by,
          dispatched_to: null,
          dispatched_at: null,
          source_ref,
          created_at: ts,
          updated_at: ts,
        };
        stmts.insertTicket.run(row);
        recordEvent({
          ticket_id: id,
          project_id,
          type: 'created',
          actor: created_by,
          data: { kind, state, title },
        });
        return row;
      });
      return hydrateTicket(txn());
    },

    getTicket(id) {
      const row = stmts.getTicket.get(id);
      if (!row) return null;
      const comments = stmts.getComments.all(id);
      const links = stmts.listLinks.all(id, id);
      return { ...hydrateTicket(row), comments, links };
    },

    // TKT-0107: maximum updated_at across all tickets for a project. Powers
    // the composite last_activity_at signal in the sidebar ordering.
    // Returns 0 when the project has no tickets.
    maxTicketUpdatedAt(projectId) {
      if (!projectId) return 0;
      const row = db.prepare(
        'SELECT MAX(updated_at) AS m FROM tickets WHERE project_id = ?'
      ).get(projectId);
      if (!row?.m) return 0;
      // updated_at is stored as ISO text; parse to ms.
      const t = Date.parse(row.m);
      return Number.isFinite(t) ? t : 0;
    },

    listTickets(filter = {}) {
      const { project_id, state, assignee, kind, stream_id, includeArchived } = filter;
      const where = [];
      const params = {};
      if (project_id != null) {
        where.push('project_id = @project_id');
        params.project_id = project_id;
      }
      if (state != null) {
        where.push('state = @state');
        params.state = state;
      }
      if (assignee != null) {
        where.push('assignee = @assignee');
        params.assignee = assignee;
      }
      if (kind != null) {
        where.push('kind = @kind');
        params.kind = kind;
      }
      if (stream_id != null) {
        where.push('stream_id = @stream_id');
        params.stream_id = stream_id;
      }
      // Exclude archived by default unless explicitly asking for it.
      if (state !== 'archived' && !includeArchived) {
        where.push("state != 'archived'");
      }
      const sql =
        'SELECT * FROM tickets' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY seq ASC';
      return db.prepare(sql).all(params).map(hydrateTicket);
    },

    updateTicket(id, patch = {}) {
      const existing = stmts.getTicket.get(id);
      if (!existing) throw new Error(`updateTicket: ticket '${id}' not found`);

      const actor = patch.actor ?? 'human';
      const ALLOWED = ['title', 'body', 'kind', 'state', 'priority', 'labels', 'stream_id', 'parent_id', 'assignee'];
      const updates = {};
      for (const key of ALLOWED) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          updates[key] = patch[key];
        }
      }
      if ('kind' in updates && !KINDS.has(updates.kind)) {
        throw new Error(`updateTicket: invalid kind '${updates.kind}'`);
      }
      if ('state' in updates && !STATES.has(updates.state)) {
        throw new Error(`updateTicket: invalid state '${updates.state}'`);
      }
      if ('labels' in updates) {
        updates.labels = serializeLabels(updates.labels);
      }
      if ('body' in updates) {
        updates.body = toMarkdownBody(updates.body);
      }

      const ts = now();
      const txn = db.transaction(() => {
        if (Object.keys(updates).length) {
          const setClause = Object.keys(updates)
            .map((k) => `${k} = @${k}`)
            .join(', ');
          db.prepare(`UPDATE tickets SET ${setClause}, updated_at = @updated_at WHERE id = @id`).run({
            ...updates,
            updated_at: ts,
            id,
          });
        } else {
          stmts.touchTicket.run(ts, id);
        }
        if ('state' in updates && updates.state !== existing.state) {
          recordEvent({
            ticket_id: id,
            project_id: existing.project_id,
            type: 'state_change',
            actor,
            data: { from: existing.state, to: updates.state },
          });
        }
        if ('assignee' in updates && updates.assignee !== existing.assignee) {
          recordEvent({
            ticket_id: id,
            project_id: existing.project_id,
            type: 'assigned',
            actor,
            data: { from: existing.assignee, to: updates.assignee },
          });
        }
        return stmts.getTicket.get(id);
      });
      return hydrateTicket(txn());
    },

    // TKT-0105: state + rank move in a single transaction. Used by the
    // /api/tickets/:id/move endpoint (drag-and-drop, archive drop, etc.).
    //   { state, before_id?, after_id?, actor? }
    //   - state      — new state (required).
    //   - before_id  — drop position: the moved ticket is placed after this
    //                  ticket within the target state (NULL = top).
    //   - after_id   — drop position: the moved ticket is placed before this
    //                  ticket within the target state (NULL = bottom).
    //   - actor      — recorded on the audit event.
    // Rank is computed as the midpoint of the neighbour ranks; if both
    // before_id and after_id are NULL, the moved ticket gets max(rank)+1000
    // (appended to end of target state).
    moveTicket(id, { state, before_id = null, after_id = null, actor = 'human' } = {}) {
      const existing = stmts.getTicket.get(id);
      if (!existing) throw new Error(`moveTicket: ticket '${id}' not found`);
      if (!STATES.has(state)) throw new Error(`moveTicket: invalid state '${state}'`);
      const ts = now();
      const txn = db.transaction(() => {
        // Compute new rank based on neighbours within the target state.
        const beforeRank = before_id
          ? (db.prepare('SELECT rank FROM tickets WHERE id = ?').get(before_id)?.rank ?? null)
          : null;
        const afterRank = after_id
          ? (db.prepare('SELECT rank FROM tickets WHERE id = ?').get(after_id)?.rank ?? null)
          : null;
        let newRank;
        if (before_id && after_id && beforeRank !== null && afterRank !== null) {
          newRank = (beforeRank + afterRank) / 2;
        } else if (beforeRank !== null && afterRank !== null) {
          newRank = (beforeRank + afterRank) / 2;
        } else if (beforeRank !== null) {
          newRank = beforeRank + 500;
        } else if (afterRank !== null) {
          newRank = afterRank - 500;
        } else {
          // Append to end of target state.
          const maxRow = db.prepare(
            "SELECT MAX(rank) AS m FROM tickets WHERE state = ? AND id != ?"
          ).get(state, id);
          newRank = (maxRow?.m ?? 0) + 1000;
        }
        // Build the SET clause: state + rank + lifecycle stamps.
        const setDoneAt = state === 'done' ? ', done_at = @ts' : '';
        const setArchivedAt = state === 'archived' ? ', archived_at = @ts' : '';
        db.prepare(`UPDATE tickets SET
          state = @state,
          rank = @rank,
          state_changed_at = @ts,
          updated_at = @ts
          ${setDoneAt}
          ${setArchivedAt}
        WHERE id = @id`).run({ state, rank: newRank, ts, id });
        // Audit event for the state change. Rank-only moves within the
        // same state still record an event for traceability.
        if (state !== existing.state) {
          recordEvent({
            ticket_id: id,
            project_id: existing.project_id,
            type: 'state_change',
            actor,
            data: { from: existing.state, to: state, before_id, after_id, new_rank: newRank },
          });
        } else {
          recordEvent({
            ticket_id: id,
            project_id: existing.project_id,
            type: 'rank_change',
            actor,
            data: { before_id, after_id, new_rank: newRank },
          });
        }
        return stmts.getTicket.get(id);
      });
      return hydrateTicket(txn());
    },

    // TKT-0105: 14-day done → archived sweep. Returns the list of ids
    // that were auto-archived so the caller can broadcast a single
    // batch-updated WS delta instead of one per ticket.
    autoArchiveDone(nowTs = now(), olderThanDays = 14) {
      const cutoff = new Date(Date.parse(nowTs) - olderThanDays * 86400_000).toISOString();
      const txn = db.transaction(() => {
        const rows = db.prepare(
          "SELECT id FROM tickets WHERE state = 'done' AND done_at IS NOT NULL AND done_at < ?"
        ).all(cutoff);
        if (rows.length === 0) return [];
        const ts = now();
        const update = db.prepare(
          "UPDATE tickets SET state = 'archived', archived_at = @ts, state_changed_at = @ts, updated_at = @ts WHERE id = @id"
        );
        const record = db.prepare(
          "INSERT INTO events(ticket_id, project_id, type, actor, data, created_at) VALUES (@ticket_id, @project_id, 'auto_archived', 'system', @data, @ts)"
        );
        const updated = [];
        for (const { id } of rows) {
          const t = stmts.getTicket.get(id);
          if (!t) continue;
          update.run({ id, ts });
          record.run({
            ticket_id: id,
            project_id: t.project_id,
            ts,
            data: JSON.stringify({ from: 'done', to: 'archived', done_at: t.done_at }),
          });
          updated.push(id);
        }
        return updated;
      });
      return txn();
    },

    setDispatched(id, { session_id, actor = 'human' } = {}) {
      const existing = stmts.getTicket.get(id);
      if (!existing) throw new Error(`setDispatched: ticket '${id}' not found`);
      if (!session_id) throw new Error('setDispatched: session_id is required');
      const ts = now();
      const txn = db.transaction(() => {
        db.prepare(
          'UPDATE tickets SET assignee = @s, dispatched_to = @s, dispatched_at = @ts, updated_at = @ts WHERE id = @id',
        ).run({ s: session_id, ts, id });
        recordEvent({
          ticket_id: id,
          project_id: existing.project_id,
          type: 'dispatched',
          actor,
          data: { session_id },
        });
        return stmts.getTicket.get(id);
      });
      return hydrateTicket(txn());
    },

    addComment(ticket_id, input = {}) {
      const existing = stmts.getTicket.get(ticket_id);
      if (!existing) throw new Error(`addComment: ticket '${ticket_id}' not found`);
      const {
        author, body, quote, prefix, suffix, section, section_id,
        tag = 'note', status = 'open', parent_id, block_id,
      } = input;
      if (!author) throw new Error('addComment: author is required');
      if (body == null) throw new Error('addComment: body is required');
      if (tag && !COMMENT_TAGS.has(tag)) throw new Error(`addComment: invalid tag '${tag}'`);
      const ts = now();
      const row = {
        id: crypto.randomUUID(), ticket_id, author,
        body: toMarkdownBody(body),
        quote: quote ?? null,
        prefix: prefix ?? null,
        suffix: suffix ?? null,
        section: section ?? null,
        section_id: section_id ?? null,
        tag,
        status,
        parent_id: parent_id ?? null,
        block_id: block_id ?? null,
        created_at: ts,
        updated_at: ts,
      };
      const txn = db.transaction(() => {
        stmts.insertComment.run(row);
        stmts.touchTicket.run(ts, ticket_id);
        recordEvent({
          ticket_id,
          project_id: existing.project_id,
          type: 'commented',
          actor: author,
          data: { comment_id: row.id },
        });
        return row;
      });
      return txn();
    },

    updateComment(ticket_id, comment_id, patch = {}) {
      const existingTicket = stmts.getTicket.get(ticket_id);
      if (!existingTicket) throw new Error(`updateComment: ticket '${ticket_id}' not found`);
      const existing = db.prepare('SELECT * FROM comments WHERE id = ? AND ticket_id = ?').get(comment_id, ticket_id);
      if (!existing) throw new Error(`updateComment: comment '${comment_id}' not found`);
      const ALLOWED = ['body', 'tag', 'status', 'block_id'];
      const updates = {};
      for (const key of ALLOWED) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) updates[key] = patch[key];
      }
      if ('body' in updates) updates.body = toMarkdownBody(updates.body);
      if ('tag' in updates && updates.tag && !COMMENT_TAGS.has(updates.tag)) {
        throw new Error(`updateComment: invalid tag '${updates.tag}'`);
      }
      if (!Object.keys(updates).length) return existing;
      const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
      const ts = now();
      db.prepare(`UPDATE comments SET ${setClause}, updated_at = @updated_at WHERE id = @id AND ticket_id = @ticket_id`).run({
        ...updates,
        updated_at: ts,
        id: comment_id,
        ticket_id,
      });
      stmts.touchTicket.run(ts, ticket_id);
      recordEvent({
        ticket_id,
        project_id: existingTicket.project_id,
        type: 'comment_updated',
        actor: patch.actor ?? existing.author,
        data: { comment_id },
      });
      return db.prepare('SELECT * FROM comments WHERE id = ?').get(comment_id);
    },

    createStream(input = {}) {
      const { project_id, name, mode = 'parallel', description = '' } = input;
      if (!project_id) throw new Error('createStream: project_id is required');
      if (!name) throw new Error('createStream: name is required');
      if (!STREAM_MODES.has(mode)) throw new Error(`createStream: invalid mode '${mode}'`);
      const ts = now();
      const row = { id: crypto.randomUUID(), project_id, name, mode, description, created_at: ts, updated_at: ts };
      stmts.insertStream.run(row);
      return row;
    },

    listStreams(project_id) {
      return stmts.listStreams.all(project_id);
    },

    updateStream(id, patch = {}) {
      const existing = stmts.getStream.get(id);
      if (!existing) throw new Error(`updateStream: stream '${id}' not found`);
      const ALLOWED = ['name', 'mode', 'description'];
      const updates = {};
      for (const key of ALLOWED) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) updates[key] = patch[key];
      }
      if ('mode' in updates && !STREAM_MODES.has(updates.mode)) {
        throw new Error(`updateStream: invalid mode '${updates.mode}'`);
      }
      const ts = now();
      if (Object.keys(updates).length) {
        const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
        db.prepare(`UPDATE streams SET ${setClause}, updated_at = @updated_at WHERE id = @id`).run({
          ...updates,
          updated_at: ts,
          id,
        });
      } else {
        db.prepare('UPDATE streams SET updated_at = ? WHERE id = ?').run(ts, id);
      }
      return stmts.getStream.get(id);
    },

    addLink(from_ticket, to_ticket, type) {
      if (!LINK_TYPES.has(type)) throw new Error(`addLink: invalid type '${type}'`);
      if (!stmts.getTicket.get(from_ticket)) throw new Error(`addLink: from_ticket '${from_ticket}' not found`);
      if (!stmts.getTicket.get(to_ticket)) throw new Error(`addLink: to_ticket '${to_ticket}' not found`);
      stmts.insertLink.run(from_ticket, to_ticket, type);
      return { from_ticket, to_ticket, type };
    },

    removeLink(from_ticket, to_ticket, type) {
      const info = stmts.deleteLink.run(from_ticket, to_ticket, type);
      return { removed: info.changes };
    },

    listLinks(ticket_id) {
      return stmts.listLinks.all(ticket_id, ticket_id);
    },

    listEvents({ ticket_id, project_id, limit = 100 } = {}) {
      const where = [];
      const params = {};
      if (ticket_id != null) {
        where.push('ticket_id = @ticket_id');
        params.ticket_id = ticket_id;
      }
      if (project_id != null) {
        where.push('project_id = @project_id');
        params.project_id = project_id;
      }
      params.limit = limit;
      const sql =
        'SELECT * FROM events' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY id DESC LIMIT @limit';
      return db.prepare(sql).all(params).map((e) => ({ ...e, data: safeParse(e.data) }));
    },
  };

  return api.init();
}
