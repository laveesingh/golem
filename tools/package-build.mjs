import { fileURLToPath } from 'node:url';
import { buildPackage } from './package-stage.ts';

buildPackage(fileURLToPath(new URL('../', import.meta.url)));
