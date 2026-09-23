// Substrate size report — one check over substrate/ (instructions, roles,
// skills; README excluded): the total word count against one cap (GOL-366
// addendum 2 + GOL-377 addendum: human decisions set a 10k-word cap, no
// per-file caps, no reference or front-matter checks, and made an over-cap
// total a WARNING that never fails the lint or the sync check). Instruction
// content integrity is an on-demand agentic check, not a technical test.
//
// Runs once over the source tree, not per render target, so it sits beside
// checkDrift rather than inside it.

import fs from 'node:fs';
import path from 'node:path';

// GOL-366 addendum 2 (human decision, 2026-09-23): one total cap for the
// substrate, no per-file caps. An over-cap total is reported as a warning and
// never fails the lint or the sync check.
export const TOTAL_CAP = 10000;

const LINT_EXTS = new Set(['.md']);
const SKIP = new Set(['README.md']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (LINT_EXTS.has(path.extname(entry.name)) && !SKIP.has(entry.name)) out.push(abs);
  }
  return out;
}

export function lintFiles(substrateRoot) {
  const roots = ['instructions', 'roles', 'skills'].map((d) => path.join(substrateRoot, d));
  return roots.flatMap((r) => walk(r)).sort();
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

export function lintSubstrate({ substrateRoot }) {
  const files = lintFiles(substrateRoot);
  let total = 0;
  for (const file of files) total += countWords(fs.readFileSync(file, 'utf8'));

  const warnings = [];
  if (total > TOTAL_CAP) {
    warnings.push({ check: 'cap', file: '(total)', detail: `total ${total} words, cap ${TOTAL_CAP}` });
  }

  // GOL-377 addendum: no instruction-content checks of any kind remain, so
  // the report can never fail — `clean`/`findings` are kept for the existing
  // callers and are always true/[].
  return { clean: true, findings: [], warnings, total, files: files.length };
}