#!/usr/bin/env node
/** Remove only the repository's generated build directory before packaging. */

import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(resolve(ROOT, 'dist'), { force: true, recursive: true });
