// Test-only installation facade, not a product fallback or executable.
import path from 'node:path';
import {createServerAdapter as factory} from '../index.mjs';
export * from '../index.mjs';
export const OMP_COMMAND = path.join(import.meta.dirname, 'synthetic-installation', 'omp');
export const createServerAdapter = (deps = {}) => factory({ompCommand: OMP_COMMAND, ...deps});
