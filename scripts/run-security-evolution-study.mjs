#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { preparePublicCorpus } from './security-evolution-study/corpus.mjs';
import { preregister } from './security-evolution-study/protocol.mjs';
import { createExistingRuntimeProvider, deterministicControlProvider, runPreregisteredStudy } from './security-evolution-study/run.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, args[i])) throw new Error('options require unique --name value pairs');
  options[args[i]] = args[i + 1];
}
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const output = value => {
  if (!options['--output']) throw new Error('--output is required');
  writeFileSync(options['--output'], `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: options['--output'], digest: value.protocolDigest ?? value.digest, conclusion: value.conclusion, mode: value.mode, billedUsd: value.cost?.billedUsd, meteredTariffUsd: value.cost?.meteredTariffUsd, dispatchedCalls: value.cost?.dispatchedCalls }));
};
if (command === 'prepare') output(await preparePublicCorpus());
else if (command === 'preregister') {
  output(preregister(read(options['--corpus']), { budgetUsd: Number(options['--budget-usd'] ?? 20), perCallCeilingUsd: Number(options['--call-ceiling-usd'] ?? .1), repeats: Number(options['--repeats'] ?? 2), model: options['--model'] ?? 'gpt-4.1-mini-2025-04-14' }));
} else if (command === 'controls' || command === 'run') {
  const protocol = read(options['--protocol']); const corpus = read(options['--corpus']);
  const mode = command === 'run' ? 'provider' : 'controls';
  const provider = mode === 'provider' ? await createExistingRuntimeProvider(protocol) : deterministicControlProvider({ unknownUsageAt: options['--unknown-usage-at'] ? Number(options['--unknown-usage-at']) : null });
  output(await runPreregisteredStudy({ corpus, protocol, mode, provider, ledgerPath: `${options['--output']}.ledger.jsonl`, approvedBudgetUsd: Number(options['--approved-budget-usd'] ?? 0) }));
} else throw new Error('usage: node scripts/run-security-evolution-study.mjs prepare|preregister|controls|run --output NEWFILE [--corpus FILE --protocol FILE --budget-usd N --call-ceiling-usd N --approved-budget-usd N]');
