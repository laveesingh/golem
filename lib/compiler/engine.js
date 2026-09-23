// Compiler engine — adapter-agnostic render/lockfile/tamper/orphan machinery
// (TKT-0574, ADR-2/ADR-5). Adapters (lib/compiler/adapters/*.js) build a list
// of RenderItems from substrate/ sources; this module writes them to an
// output dir, tracks provenance in ~/.golem/substrate.lock, refuses to
// silently clobber a hand-edited output (tamper), and deletes outputs whose
// source no longer exists (orphans).
//
// A RenderItem is: { key, outputRelPath, sourceSha256, build() -> Buffer|string }
// `key` is the stable lockfile identifier (usually the source-relative path).
// `sourceSha256` represents the source input(s) this item derives from — for
// most items that's one file's hash; plugin.json's item combines
// plugin-meta.json + the root package.json version, so its sourceSha256 is a
// hash of both concatenated.
//
// Block RenderItems add: { type:'block', beginMarker, endMarker }. Their build()
// bytes are spliced between markers in an existing destination file; the lockfile
// stores only the managed-region hash, so user text outside the markers is never
// treated as drift or tamper.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { substrateLockPath } from '../golem-home.js';

const LOCK_VERSION = 1;

export function sha256(bufOrString) {
  const buf = Buffer.isBuffer(bufOrString) ? bufOrString : Buffer.from(bufOrString, 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

/**
 * Minimal templating (ADR-2): {{#if <flag>}}...{{/if}} conditional blocks
 * (kept when context[flag] is truthy, stripped otherwise) then {{var}}
 * substitution from context. P2 sources carry no template markers yet — this
 * exists so the capability is real and tested, not exercised by content.
 */
export function applyTemplate(text, context = {}) {
  let out = text.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, flag, inner) => (
    context[flag] ? inner : ''
  ));
  out = out.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in context ? String(context[key]) : m));
  return out;
}

export function readLockfile() {
  try {
    return JSON.parse(fs.readFileSync(substrateLockPath(), 'utf8'));
  } catch {
    return { version: LOCK_VERSION, targets: {} };
  }
}

export function writeLockfile(lock) {
  const p = substrateLockPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(lock, null, 2) + '\n');
}

function currentOutputHash(outAbs) {
  try {
    return sha256File(outAbs);
  } catch {
    return null; // doesn't exist
  }
}

function isBlockItem(item) {
  return item.type === 'block';
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function framedBlock(item, inner) {
  return `${item.beginMarker}\n${ensureTrailingNewline(inner)}${item.endMarker}\n`;
}

function markerCount(text, marker) {
  return text.split(marker).length - 1;
}

function parseBlock(text, item) {
  const begin = item.beginMarker;
  const end = item.endMarker;
  const beginCount = markerCount(text, begin);
  const endCount = markerCount(text, end);
  if (beginCount !== 1 || endCount !== 1) {
    // No markers at all is not damage — it is a file golem has never managed,
    // i.e. first adoption of an instructions file the human already wrote.
    // That is recoverable by appending; a partial or duplicated marker set is
    // not, and must stay a hard refusal.
    return {
      ok: false,
      pristine: beginCount === 0 && endCount === 0,
      reason: beginCount === 0 && endCount === 0
        ? `no ${begin} region yet`
        : `expected exactly one ${begin} and one ${end} marker`,
    };
  }
  const beginIdx = text.indexOf(begin);
  const afterBegin = beginIdx + begin.length;
  const contentStart = text.startsWith('\r\n', afterBegin) ? afterBegin + 2 : text.startsWith('\n', afterBegin) ? afterBegin + 1 : afterBegin;
  const endIdx = text.indexOf(end, contentStart);
  if (endIdx < contentStart) return { ok: false, reason: `end marker appears before begin marker for ${begin}` };
  let suffixStart = endIdx + end.length;
  if (text.startsWith('\r\n', suffixStart)) suffixStart += 2;
  else if (text.startsWith('\n', suffixStart)) suffixStart += 1;
  return {
    ok: true,
    prefix: text.slice(0, beginIdx),
    inner: text.slice(contentStart, endIdx),
    suffix: text.slice(suffixStart),
  };
}

function blockDiskState(outAbs, item) {
  try {
    const text = fs.readFileSync(outAbs, 'utf8');
    const parsed = parseBlock(text, item);
    if (!parsed.ok) return { exists: true, valid: false, pristine: parsed.pristine === true, reason: parsed.reason };
    return { exists: true, valid: true, ...parsed, blockSha: sha256(parsed.inner) };
  } catch {
    return { exists: false, valid: false, pristine: false, reason: 'destination file is missing' };
  }
}

// Never truncates. Everything outside the managed region belongs to the human,
// and these destinations (~/.claude/CLAUDE.md) routinely
// hold their own rules. Replacing the file with the block alone would delete
// those silently, so adoption and repair both append instead.
function writeBlock(outAbs, item, inner, state) {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const block = framedBlock(item, inner);
  if (state?.exists && state.valid) {
    fs.writeFileSync(outAbs, state.prefix + block + state.suffix);
    return;
  }
  if (!state?.exists) {
    fs.writeFileSync(outAbs, block);
    return;
  }
  const existing = fs.readFileSync(outAbs, 'utf8');
  fs.writeFileSync(outAbs, `${ensureTrailingNewline(existing)}\n${block}`);
}

function removeBlock(outAbs, prev) {
  try {
    const text = fs.readFileSync(outAbs, 'utf8');
    const parsed = parseBlock(text, { beginMarker: prev.begin_marker, endMarker: prev.end_marker });
    if (!parsed.ok) return false;
    fs.writeFileSync(outAbs, parsed.prefix + parsed.suffix);
    return true;
  } catch {
    return false;
  }
}

// Lockfile sections are keyed by (target, outDir), not target alone — two
// syncs of the same target to different output dirs (e.g. the real shadow
// render vs. a one-off `--out` regeneration of the committed plugin/ tree)
// must never share tamper/orphan bookkeeping, or the second sync's disk
// state gets diffed against the first sync's recorded hashes and everything
// reads as tampered.
function lockKey(target, outDir) {
  return `${target}::${outDir}`;
}

function targetBucket(lock, projectId) {
  if (!projectId) {
    lock.targets = lock.targets ?? {};
    return lock.targets;
  }
  lock.projects = lock.projects ?? {};
  lock.projects[projectId] = lock.projects[projectId] ?? { project_id: projectId, targets: {} };
  lock.projects[projectId].targets = lock.projects[projectId].targets ?? {};
  return lock.projects[projectId].targets;
}

function readonlyTargetBucket(lock, projectId) {
  if (!projectId) return lock.targets ?? {};
  return lock.projects?.[projectId]?.targets ?? {};
}

/**
 * After pruning a file, remove parent directories the removal left empty —
 * bounded to strictly inside `outDir`, which is never removed itself.
 *
 * Without this, deleting a skill leaves `skills/<name>/` behind forever: the
 * lockfile tracks files, so `checkDrift` keeps reporting clean while the render
 * tree accumulates dead directories. Harmless to loaders (no `SKILL.md` means
 * nothing loads) but it makes every render tree progressively less trustworthy
 * as a picture of what substrate actually contains.
 *
 * Stops climbing on the first non-empty or non-removable directory, so a
 * sibling file anywhere up the chain protects everything above it.
 */
function pruneEmptyParents(outDir, fileAbs) {
  const root = path.resolve(outDir);
  let dir = path.dirname(path.resolve(fileAbs));
  while (dir.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return; // not empty, already gone, or not removable — stop.
    }
    dir = path.dirname(dir);
  }
}

/**
 * Render `items` into `outDir`, updating the lockfile's (target, outDir)
 * section. Refuses (does not overwrite) any output whose on-disk hash
 * doesn't match the lockfile's last-recorded output hash for that key,
 * unless `force`. Deletes outputs for keys that existed in the previous
 * sync but are absent from `items` (their source was removed — orphan
 * pruning).
 */
export function render({ target, outDir, items, packageVersion, force = false, projectId = null }) {
  const lock = readLockfile();
  const key = lockKey(target, outDir);
  const bucket = targetBucket(lock, projectId);
  const prevFiles = bucket[key]?.files ?? {};
  const newFiles = {};
  const written = [];
  const unchanged = [];
  const tampered = [];
  const pruned = [];

  fs.mkdirSync(outDir, { recursive: true });

  for (const item of items) {
    const content = item.build();
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const text = buf.toString('utf8');
    const outAbs = path.join(outDir, item.outputRelPath);
    // Hash the normalized form that actually gets written. framedBlock() adds a
    // trailing newline to the inner content, so hashing the raw build would not
    // match the block re-read from disk, and a source without a trailing
    // newline would report tamper on every re-render and never update again.
    const outputSha = isBlockItem(item) ? sha256(ensureTrailingNewline(text)) : sha256(buf);
    const prev = prevFiles[item.key];
    const blockState = isBlockItem(item) ? blockDiskState(outAbs, item) : null;
    const diskSha = isBlockItem(item) ? (blockState.valid ? blockState.blockSha : null) : currentOutputHash(outAbs);

    // A destination with no managed region yet is adoption, not tampering:
    // golem has never written there, so nothing of ours can be lost and the
    // block is appended below the human's existing content. Only a partial or
    // duplicated marker set is real damage, and that still needs --force.
    const blockNeedsForce = isBlockItem(item) && blockState.exists && !blockState.valid && !blockState.pristine;
    if (blockNeedsForce && !force) {
      tampered.push({ key: item.key, outputRelPath: item.outputRelPath, outAbs, reason: blockState.reason, block: true });
      if (prev) newFiles[item.key] = prev;
      continue;
    }

    if (diskSha !== null && prev && diskSha !== prev.output_sha256) {
      // Someone (or something) edited the rendered file outside of sync.
      if (!force) {
        tampered.push({ key: item.key, outputRelPath: item.outputRelPath, outAbs, reason: isBlockItem(item) ? 'managed block content differs from the lockfile hash' : 'output file hash differs from lockfile', block: isBlockItem(item) });
        newFiles[item.key] = prev; // carry the old lockfile entry forward untouched
        continue;
      }
    }

    if (diskSha === outputSha) {
      // Freshly-built bytes already match what's on disk — nothing to write.
      // Compared against a fresh build, not the lockfile's memory of the
      // last build, so an adapter/template change (not just a source-file
      // change) still produces new bytes and isn't masked as "unchanged".
      unchanged.push(item.key);
      newFiles[item.key] = {
        source_sha256: item.sourceSha256,
        output_path: item.outputRelPath,
        output_sha256: outputSha,
        ...(isBlockItem(item) ? { kind: 'block', begin_marker: item.beginMarker, end_marker: item.endMarker } : {}),
      };
      continue;
    }

    if (isBlockItem(item)) writeBlock(outAbs, item, text, blockState);
    else {
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, buf);
      if (item.mode) fs.chmodSync(outAbs, item.mode);
    }
    written.push(item.key);
    newFiles[item.key] = {
      source_sha256: item.sourceSha256,
      output_path: item.outputRelPath,
      output_sha256: outputSha,
      ...(isBlockItem(item) ? { kind: 'block', begin_marker: item.beginMarker, end_marker: item.endMarker } : {}),
    };
  }

  // Orphans: keys tracked last sync but not produced this time.
  for (const [key, prev] of Object.entries(prevFiles)) {
    if (key in newFiles) continue;
    const outAbs = path.join(outDir, prev.output_path);
    try {
      if (prev.kind === 'block') {
        if (removeBlock(outAbs, prev)) pruned.push({ key, outputRelPath: prev.output_path });
      } else {
        fs.unlinkSync(outAbs);
        pruneEmptyParents(outDir, outAbs);
        pruned.push({ key, outputRelPath: prev.output_path });
      }
    } catch {
      // already gone — fine.
    }
  }

  lock.version = LOCK_VERSION;
  lock.package_version = packageVersion;
  bucket[key] = {
    target,
    out_dir: outDir,
    ...(projectId ? { project_id: projectId } : {}),
    synced_at: new Date().toISOString(),
    files: newFiles,
  };
  writeLockfile(lock);

  return { written, unchanged, tampered, pruned };
}

/**
 * Dry-run: compute drift without writing anything or touching the lockfile.
 * Returns { clean, drifted: [{key, reason}], orphaned: [{key}] }.
 * reason is one of: 'new' (no prior render), 'changed' (source or output
 * differs from lockfile), 'tampered' (on-disk output edited out-of-band).
 */
export function checkDrift({ target, outDir, items, projectId = null }) {
  const lock = readLockfile();
  const prevFiles = readonlyTargetBucket(lock, projectId)?.[lockKey(target, outDir)]?.files ?? {};
  const drifted = [];
  const seen = new Set();

  for (const item of items) {
    seen.add(item.key);
    const prev = prevFiles[item.key];
    const outAbs = path.join(outDir, item.outputRelPath);
    const blockState = isBlockItem(item) ? blockDiskState(outAbs, item) : null;
    const diskSha = isBlockItem(item) ? (blockState.valid ? blockState.blockSha : null) : currentOutputHash(outAbs);
    // Mirrors render(): a destination with no managed region yet is adoption,
    // reported as ordinary drift, not as tamper. Only a partial or duplicated
    // marker set is damage.
    const blockDamaged = isBlockItem(item) && blockState.exists && !blockState.valid && !blockState.pristine;
    if (!prev) {
      drifted.push({ key: item.key, reason: blockDamaged ? 'tampered' : 'new' });
      continue;
    }
    if (blockDamaged) {
      drifted.push({ key: item.key, reason: 'tampered' });
      continue;
    }
    if (diskSha !== null && diskSha !== prev.output_sha256) {
      drifted.push({ key: item.key, reason: 'tampered' });
      continue;
    }
    // Compare a fresh build against disk, not just the lockfile's memory of
    // the source hash — an adapter/template change with an unchanged source
    // file must still show up as drift. Block items compare the normalized
    // form, matching what render() hashes and what framedBlock() writes.
    const content = item.build();
    const freshSha = isBlockItem(item)
      ? sha256(ensureTrailingNewline(typeof content === 'string' ? content : content.toString('utf8')))
      : sha256(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
    if (diskSha === null || freshSha !== diskSha) {
      drifted.push({ key: item.key, reason: 'changed' });
    }
  }

  const orphaned = Object.keys(prevFiles)
    .filter((key) => !seen.has(key))
    .map((key) => ({ key }));

  return { clean: drifted.length === 0 && orphaned.length === 0, drifted, orphaned };
}
