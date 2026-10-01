#!/usr/bin/env node
// Checkout uses native TypeScript. W3's publication step emits this graph.
import { runBootstrap } from './bootstrap.ts';
runBootstrap().catch(error => { console.error(`golem: ${error.message}`); process.exitCode = 2; });
