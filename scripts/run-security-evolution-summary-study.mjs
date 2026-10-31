#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { preregisterSummaryAblation, runSummaryAblation } from './security-evolution-study/summary-ablation.mjs';
import { createExistingRuntimeProvider, deterministicControlProvider } from './security-evolution-study/run.mjs';
const [command, ...args] = process.argv.slice(2); const options = {};
for (let i = 0; i < args.length; i += 2) { if (!args[i]?.startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, args[i])) throw new Error('unique --name value options required'); options[args[i]] = args[i + 1]; }
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const corpus = read(options['--corpus']); const protocol = read(options['--protocol']);
if (!options['--output']) throw new Error('--output NEWFILE is required');
let result;
if (command === 'preregister') result = preregisterSummaryAblation(protocol, corpus);
else if (command === 'controls' || command === 'run') {
  const mode = command === 'run' ? 'provider' : 'controls';
  result = await runSummaryAblation({ protocol, corpus, preregistration: read(options['--preregistration']), mode, providerFactory: () => mode === 'provider' ? createExistingRuntimeProvider(protocol) : deterministicControlProvider({ unknownUsageAt: options['--unknown-usage-at'] ? Number(options['--unknown-usage-at']) : null }), ledgerPrefix: options['--output'], approvedSharedBudgetUsd: Number(options['--approved-shared-budget-usd'] ?? 0), qualifiedPilotReport: options['--qualified-pilot-report'] ? read(options['--qualified-pilot-report']) : null });
} else throw new Error('usage: preregister|controls|run --corpus FILE --protocol FILE --preregistration FILE --output NEWFILE');
writeFileSync(options['--output'], `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: options['--output'], preregistrationDigest: result.preregistrationDigest, conclusion: result.conclusion, actualSharedMeteredTariffUsd: result.actualSharedMeteredTariffUsd, invoiceUsd: result.invoiceUsd, currentFeedbackRetained: result.currentFeedbackRetained }));
