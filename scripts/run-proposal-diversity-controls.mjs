#!/usr/bin/env node
// Build @0/core first. Never instantiates a provider or spends a model budget.
import { writeFileSync } from 'node:fs';
import { runProposalDiversityControls } from '../packages/core/dist/improvement/proposal-diversity-controls.js';
const result = await runProposalDiversityControls(process.argv.includes('--inconclusive') ? 'inconclusive' : 'null');
const json = JSON.stringify(result, null, 2) + '\n';
const index = process.argv.indexOf('--output');
if (index !== -1) {
  if (!process.argv[index + 1]) throw new Error('--output needs a destination');
  writeFileSync(process.argv[index + 1], json);
} else process.stdout.write(json);
