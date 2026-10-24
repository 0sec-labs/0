#!/usr/bin/env node
// Build @0/core first. These fixtures never instantiate a provider runtime.
import { writeFileSync } from 'node:fs';
import { runArchiveStudyControls } from '../packages/core/dist/improvement/search-study-controls.js';
const mode = process.argv.includes('--regression') ? 'regression' : 'aa';
const outputIndex = process.argv.indexOf('--output');
const result = await runArchiveStudyControls(mode);
const json = JSON.stringify(result, null, 2) + '\n';
if (outputIndex !== -1) {
  if (!process.argv[outputIndex + 1]) throw new Error('--output needs a destination');
  writeFileSync(process.argv[outputIndex + 1], json);
} else process.stdout.write(json);
