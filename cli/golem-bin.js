#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve links before classifying: npm link uses the checkout, whereas an
// installed package must never fall back to native TS under node_modules.
const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const installed = here.split(path.sep).includes('node_modules');
const source = new URL('./bootstrap.ts', import.meta.url);
const entry = !installed && fs.existsSync(source)
  ? source
  : new URL('../dist/cli/bootstrap.js', import.meta.url);
import(entry.href)
  .then(({ runBootstrap }) => runBootstrap())
  .catch(error => { console.error(`golem: ${error.message}`); process.exitCode = 2; });
