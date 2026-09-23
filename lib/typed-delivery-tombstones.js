// Compact, append-safe replay tombstones for typed native-worker envelopes.
// This deliberately contains no prompt content or rich adapter history: its
// only job is to preserve immutable first-acceptance lineage after the
// bounded supervisor inspection history rolls over.
import fs from 'node:fs';
import path from 'node:path';
import { typedDeliveryTombstonesDbPath } from './golem-home.js';

const stores = new Map();
const BUSY_TIMEOUT_MS = 250;

export function closeTypedDeliveryStore(file = typedDeliveryTombstonesDbPath()) {
  const key = path.resolve(file);
  const store = stores.get(key);
  if (!store) return;
  stores.delete(key);
  store.db.close();
}

export function closeTypedDeliveryStores() {
  for (const file of [...stores.keys()]) closeTypedDeliveryStore(file);
}

// Helpers borrow a synchronous connection. Their finally/close releases the
// borrow, not the cached connection; actual closure belongs to shutdown/tests.
function borrow(db) {
  let released = false;
  return {
    prepare(sql) {
      if (released) throw new Error('replay-store borrow is closed');
      return db.prepare(sql);
    },
    exec(sql) {
      if (released) throw new Error('replay-store borrow is closed');
      return db.exec(sql);
    },
    close() { released = true; },
  };
}

function open(file) {
  const key = path.resolve(file);
  const cached = stores.get(key);
  if (cached) {
    const stat = fs.existsSync(key) ? fs.statSync(key) : null;
    if (stat && stat.dev === cached.dev && stat.ino === cached.ino) return borrow(cached.db);
    closeTypedDeliveryStore(key); // a test/operator replaced the file, not the same store
  }
  // Load lazily: ordinary CLI imports need neither SQLite nor a new connection.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  fs.mkdirSync(path.dirname(key), { recursive: true });
  const db = new DatabaseSync(key);
  try {
    initialize(db);
    const stat = fs.statSync(key);
    stores.set(key, { db, dev: stat.dev, ino: stat.ino });
    return borrow(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

function initialize(db) {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS typed_delivery_tombstones (
      canonical_id TEXT NOT NULL,
      envelope_id TEXT NOT NULL,
      accepted_attempt_id TEXT,
      target_session_id TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      turn_id TEXT,
      claimed_at TEXT,
      accepted_at TEXT,
      settled_at TEXT,
      interrupted_at TEXT,
      recovery_required_at TEXT,
      -- Wire expiry is retained for audit only. It is deliberately NOT the
      -- replay-retention clock: the tracker can renew a pending lineage after
      -- a lost response, and acceptance must still win on that retry.
      expires_at TEXT NOT NULL,
      retired_at TEXT,
      PRIMARY KEY (canonical_id, envelope_id)
    );
    -- Rich tombstones can be retired once the tracker has a terminal result,
    -- but the endpoint still needs a permanent, compact replay refusal after
    -- its bounded inbox has rolled over. This index deliberately contains no
    -- content and is never reclaimed by ordinary tracker settlement.
    CREATE TABLE IF NOT EXISTS typed_delivery_rejections (
      canonical_id TEXT NOT NULL,
      envelope_id TEXT NOT NULL,
      accepted_attempt_id TEXT,
      target_session_id TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      turn_id TEXT,
      accepted_at TEXT,
      terminal_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (canonical_id, envelope_id)
    );
  `);
  const cols = db.prepare('PRAGMA table_info(typed_delivery_tombstones)').all().map((col) => col.name);
  if (!cols.includes('retired_at')) db.exec('ALTER TABLE typed_delivery_tombstones ADD COLUMN retired_at TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_typed_delivery_tombstones_expiry
      ON typed_delivery_tombstones(expires_at);
    CREATE INDEX IF NOT EXISTS idx_typed_delivery_tombstones_retired
      ON typed_delivery_tombstones(retired_at) WHERE retired_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_typed_delivery_rejections_terminal
      ON typed_delivery_rejections(terminal_at);
  `);
}

function rowToTombstone(row) {
  return row ? {
    canonical_id: row.canonical_id,
    envelope_id: row.envelope_id,
    accepted_attempt_id: row.accepted_attempt_id,
    target_session_id: row.target_session_id,
    lifecycle_state: row.lifecycle_state,
    turn_id: row.turn_id,
    claimed_at: row.claimed_at,
    accepted_at: row.accepted_at,
    settled_at: row.settled_at,
    interrupted_at: row.interrupted_at,
    recovery_required_at: row.recovery_required_at,
    expires_at: row.expires_at,
    retired_at: row.retired_at,
  } : null;
}

export function readTypedDeliveryTombstone(canonicalId, envelopeId, {
  file = typedDeliveryTombstonesDbPath(),
} = {}) {
  if (!canonicalId || !envelopeId) return null;
  const db = open(file);
  try {
    const row = db.prepare(`SELECT * FROM typed_delivery_tombstones
      WHERE canonical_id = ? AND envelope_id = ? AND retired_at IS NULL`)
      .get(canonicalId, envelopeId);
    if (row) return rowToTombstone(row);
    // A terminal tracker settlement may reclaim the richer lifecycle row, but
    // never the endpoint's last replay identity. Present the compact durable
    // refusal through the same lookup contract used by all adapters.
    return rowToTombstone(db.prepare(`SELECT canonical_id, envelope_id,
      accepted_attempt_id, target_session_id, lifecycle_state, turn_id,
      NULL AS claimed_at, accepted_at, NULL AS settled_at,
      NULL AS interrupted_at, NULL AS recovery_required_at, expires_at,
      NULL AS retired_at
      FROM typed_delivery_rejections
      WHERE canonical_id = ? AND envelope_id = ?`).get(canonicalId, envelopeId));
  } finally {
    db.close();
  }
}

/**
 * Migrate pre-tombstone typed-delivery JSON into durable tombstones. Schema 5
 * writes a compact tombstone at the same acceptance boundary as the registry
 * update, so only older inbox snapshots need migration. Re-reading stale JSON
 * must never regress a newer terminal tombstone — upsert enforces that.
 */
export function migrateTypedDeliveryTombstones(canonicalId, rawInbox, {
  file = typedDeliveryTombstonesDbPath(),
  normalize = null,
} = {}) {
  if ((Number(rawInbox?.schema) || 0) >= 5) return;
  const rows = [
    ...(Array.isArray(rawInbox?.deliveries) ? rawInbox.deliveries : []),
    ...(rawInbox?.replay_index && typeof rawInbox.replay_index === 'object'
      ? Object.values(rawInbox.replay_index) : []),
  ];
  const seen = new Set();
  for (const row of rows) {
    if (!row?.envelope_id || seen.has(row.envelope_id)) continue;
    seen.add(row.envelope_id);
    const delivery = normalize
      ? normalize({ deliveries: [row] }).deliveries[0]
      : row;
    if (!delivery) continue;
    if (![
      'accepted', 'settled', 'interrupted', 'recovery_required',
    ].includes(delivery.lifecycle_state)) continue;
    upsertTypedDeliveryTombstone(canonicalId, delivery, { file });
  }
}

export function upsertTypedDeliveryTombstone(canonicalId, delivery, {
  file = typedDeliveryTombstonesDbPath(),
} = {}) {
  if (!canonicalId || !delivery?.envelope_id || !delivery?.target_session_id || !delivery?.expires_at) return null;
  const db = open(file);
  try {
    // A restarted adapter can carry stale rich JSON after the tracker retired
    // its row. The compact rejection index is authoritative and cannot be
    // shadowed/reanimated by that stale snapshot.
    if (db.prepare(`SELECT 1 FROM typed_delivery_rejections
      WHERE canonical_id = ? AND envelope_id = ?`).get(canonicalId, delivery.envelope_id)) return null;
    db.prepare(`
      INSERT INTO typed_delivery_tombstones (
        canonical_id, envelope_id, accepted_attempt_id, target_session_id,
        lifecycle_state, turn_id, claimed_at, accepted_at, settled_at,
        interrupted_at, recovery_required_at, expires_at, retired_at
      ) VALUES (
        @canonical_id, @envelope_id, @accepted_attempt_id, @target_session_id,
        @lifecycle_state, @turn_id, @claimed_at, @accepted_at, @settled_at,
        @interrupted_at, @recovery_required_at, @expires_at, NULL
      )
      ON CONFLICT(canonical_id, envelope_id) DO UPDATE SET
        accepted_attempt_id = COALESCE(typed_delivery_tombstones.accepted_attempt_id, excluded.accepted_attempt_id),
        target_session_id = typed_delivery_tombstones.target_session_id,
        -- The registry can be stale after a crash. Advance from claimed to
        -- accepted/terminal, but never let an older JSON snapshot replace a
        -- terminal SQLite fact (settled/interrupted/recovery_required are
        -- intentionally incomparable terminal outcomes).
        lifecycle_state = CASE
          WHEN typed_delivery_tombstones.lifecycle_state IN ('settled', 'interrupted', 'recovery_required')
            THEN typed_delivery_tombstones.lifecycle_state
          WHEN excluded.lifecycle_state IN ('settled', 'interrupted', 'recovery_required')
            THEN excluded.lifecycle_state
          WHEN typed_delivery_tombstones.lifecycle_state = 'accepted' AND excluded.lifecycle_state = 'claimed'
            THEN typed_delivery_tombstones.lifecycle_state
          ELSE excluded.lifecycle_state
        END,
        turn_id = COALESCE(excluded.turn_id, typed_delivery_tombstones.turn_id),
        claimed_at = COALESCE(typed_delivery_tombstones.claimed_at, excluded.claimed_at),
        accepted_at = COALESCE(typed_delivery_tombstones.accepted_at, excluded.accepted_at),
        settled_at = COALESCE(typed_delivery_tombstones.settled_at, excluded.settled_at),
        interrupted_at = COALESCE(typed_delivery_tombstones.interrupted_at, excluded.interrupted_at),
        recovery_required_at = COALESCE(typed_delivery_tombstones.recovery_required_at, excluded.recovery_required_at),
        expires_at = CASE WHEN excluded.expires_at > typed_delivery_tombstones.expires_at THEN excluded.expires_at ELSE typed_delivery_tombstones.expires_at END,
        -- Retirement is an explicit tracker-authoritative fence too. A stale
        -- restarted adapter may add older JSON facts, but cannot reactivate a
        -- lineage the tracker has declared non-renewable.
        retired_at = typed_delivery_tombstones.retired_at
    `).run({
      canonical_id: canonicalId,
      envelope_id: delivery.envelope_id,
      accepted_attempt_id: delivery.accepted_attempt_id ?? (delivery.accepted_at ? delivery.attempt_id ?? null : null),
      target_session_id: delivery.target_session_id,
      lifecycle_state: delivery.lifecycle_state,
      turn_id: delivery.turn_id ?? null,
      claimed_at: delivery.claimed_at ?? null,
      accepted_at: delivery.accepted_at ?? null,
      settled_at: delivery.settled_at ?? null,
      interrupted_at: delivery.interrupted_at ?? null,
      recovery_required_at: delivery.recovery_required_at ?? null,
      expires_at: delivery.expires_at,
    });
    return readTypedDeliveryTombstone(canonicalId, delivery.envelope_id, { file });
  } finally {
    db.close();
  }
}

// Called only after the tracker has durably recorded a terminal outcome. The
// compact identity is intentionally non-evicting: the native endpoint cannot
// safely infer that a later authenticated replay is a new logical request.
export function recordTypedDeliveryRejection(canonicalId, delivery, {
  file = typedDeliveryTombstonesDbPath(),
  at = Date.now(),
} = {}) {
  if (!canonicalId || !delivery?.envelope_id || !delivery?.target_session_id || !delivery?.expires_at) return null;
  const db = open(file);
  try {
    db.prepare(`INSERT INTO typed_delivery_rejections (
      canonical_id, envelope_id, accepted_attempt_id, target_session_id,
      lifecycle_state, turn_id, accepted_at, terminal_at, expires_at
    ) VALUES (
      @canonical_id, @envelope_id, @accepted_attempt_id, @target_session_id,
      @lifecycle_state, @turn_id, @accepted_at, @terminal_at, @expires_at
    ) ON CONFLICT(canonical_id, envelope_id) DO UPDATE SET
      accepted_attempt_id = COALESCE(typed_delivery_rejections.accepted_attempt_id, excluded.accepted_attempt_id),
      target_session_id = typed_delivery_rejections.target_session_id,
      lifecycle_state = typed_delivery_rejections.lifecycle_state,
      turn_id = COALESCE(typed_delivery_rejections.turn_id, excluded.turn_id),
      accepted_at = COALESCE(typed_delivery_rejections.accepted_at, excluded.accepted_at),
      terminal_at = typed_delivery_rejections.terminal_at,
      expires_at = CASE WHEN excluded.expires_at > typed_delivery_rejections.expires_at
        THEN excluded.expires_at ELSE typed_delivery_rejections.expires_at END
    `).run({
      canonical_id: canonicalId,
      envelope_id: delivery.envelope_id,
      accepted_attempt_id: delivery.accepted_attempt_id ?? delivery.attempt_id ?? null,
      target_session_id: delivery.target_session_id,
      lifecycle_state: delivery.lifecycle_state,
      turn_id: delivery.turn_id ?? null,
      accepted_at: delivery.accepted_at ?? null,
      terminal_at: new Date(at).toISOString(),
      expires_at: delivery.expires_at,
    });
    return readTypedDeliveryTombstone(canonicalId, delivery.envelope_id, { file });
  } finally {
    db.close();
  }
}

// Reclamation requires an explicit tracker-authoritative retirement. Never
// use envelope transport expiry here: pending lineages are renewable.
export function retireTypedDeliveryTombstones(canonicalId, envelopeIds, {
  file = typedDeliveryTombstonesDbPath(),
  at = Date.now(),
} = {}) {
  const ids = [...new Set((Array.isArray(envelopeIds) ? envelopeIds : [envelopeIds])
    .filter((value) => typeof value === 'string' && value))];
  if (!canonicalId || !ids.length) return 0;
  const db = open(file);
  try {
    const marks = ids.map(() => '?').join(', ');
    return db.prepare(`UPDATE typed_delivery_tombstones SET retired_at = ?
      WHERE canonical_id = ? AND envelope_id IN (${marks}) AND retired_at IS NULL`)
      .run(new Date(at).toISOString(), canonicalId, ...ids).changes;
  } finally {
    db.close();
  }
}

export function pruneTypedDeliveryTombstones({
  file = typedDeliveryTombstonesDbPath(),
  now = Date.now(),
} = {}) {
  const db = open(file);
  try {
    return db.prepare('DELETE FROM typed_delivery_tombstones WHERE retired_at IS NOT NULL AND retired_at <= ?')
      .run(new Date(now).toISOString()).changes;
  } finally {
    db.close();
  }
}

export function countTypedDeliveryTombstones({ file = typedDeliveryTombstonesDbPath() } = {}) {
  const db = open(file);
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM typed_delivery_tombstones').get().n;
  } finally {
    db.close();
  }
}

export function countTypedDeliveryRejections({ file = typedDeliveryTombstonesDbPath() } = {}) {
  const db = open(file);
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM typed_delivery_rejections').get().n;
  } finally {
    db.close();
  }
}

// --- GOL-365 R7: one-off legacy-harness purge -------------------------------

/** Count the tombstone + rejection rows keyed by the given canonical ids (read-only). */
export async function countTypedDeliveryTombstonesFor(canonicalIds, { file = typedDeliveryTombstonesDbPath() } = {}) {
  const ids = [...new Set(canonicalIds)].filter(Boolean);
  if (!ids.length || !fs.existsSync(file)) return 0;
  // better-sqlite3 only, and only from repo context (the scrub script): the
  // rendered Pi extension must never need it, so the import stays lazy.
  const mod = await import('better-sqlite3');
  const Database = mod.default;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const placeholders = ids.map(() => '?').join(', ');
    const tombstones = db.prepare(`SELECT COUNT(*) AS n FROM typed_delivery_tombstones WHERE canonical_id IN (${placeholders})`).get(...ids).n;
    const rejections = db.prepare(`SELECT COUNT(*) AS n FROM typed_delivery_rejections WHERE canonical_id IN (${placeholders})`).get(...ids).n;
    return tombstones + rejections;
  } finally {
    db.close();
  }
}

/** Remove every tombstone + rejection row keyed by the given canonical ids, in ONE transaction. */
export function purgeTypedDeliveryTombstones(canonicalIds, { file = typedDeliveryTombstonesDbPath() } = {}) {
  const ids = [...new Set(canonicalIds)].filter(Boolean);
  if (!ids.length) return { tombstones: 0, rejections: 0 };
  const db = open(file);
  try {
    const placeholders = ids.map(() => '?').join(', ');
    // node:sqlite has no .transaction() helper — one explicit transaction.
    db.exec('BEGIN');
    try {
      const tombstones = db.prepare(`DELETE FROM typed_delivery_tombstones WHERE canonical_id IN (${placeholders})`).run(...ids).changes;
      const rejections = db.prepare(`DELETE FROM typed_delivery_rejections WHERE canonical_id IN (${placeholders})`).run(...ids).changes;
      db.exec('COMMIT');
      return { tombstones, rejections };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  } finally {
    db.close();
  }
}
