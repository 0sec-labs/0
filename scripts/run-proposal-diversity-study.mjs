#!/usr/bin/env node
// Explicit offline entry point. Adapter modules are trusted controller code.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitSequentialPilotForDiversity, runProposalDiversityStudy, validateProposalDiversityPlan } from '../packages/core/dist/improvement/proposal-diversity-campaign.js';
import { validateSearchStudyPlan } from '../packages/core/dist/improvement/paired-search-study.js';
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); if (index === -1 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} is required`); return args[index + 1]; };
const read = name => JSON.parse(readFileSync(flag(name), 'utf8'));
const plan = read('--plan');
const qualifiedPilot = read('--pilot-evidence');
const width = Number(flag('--width'));
const parentId = flag('--parent');
const feedback = readFileSync(flag('--feedback'), 'utf8');
const approvedBudgetUsd = Number(flag('--approved-budget-usd'));
const output = flag('--output');
if (![2, 3].includes(width)) throw new Error('--width must be 2 or 3');
admitSequentialPilotForDiversity(qualifiedPilot);
validateProposalDiversityPlan(plan, width);
validateSearchStudyPlan(plan, [{ id: 'width-one', width: 1, parentId: () => parentId, feedback }, { id: `width-${width}`, width, parentId: () => parentId, feedback }]);
if (!Number.isFinite(approvedBudgetUsd) || approvedBudgetUsd <= 0 || approvedBudgetUsd > 1000 || plan.armBudgetUsd * plan.seeds.length * 2 > approvedBudgetUsd) throw new Error('explicit approved budget cannot cover the paired plan');
// Qualification, complete final capacity and spending approval are checked before
// even importing an adapter; no provider construction occurs on rejected input.
const trusted = await import(pathToFileURL(resolve(flag('--adapter'))).href);
if (typeof trusted.createAdapter !== 'function') throw new Error('trusted adapter module must export createAdapter');
const adapter = await trusted.createAdapter({ plan, qualifiedPilot, approvedBudgetUsd, parentId, width });
const result = await runProposalDiversityStudy({ plan, qualifiedPilot, approvedBudgetUsd, parentId, width, feedback, adapter });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
