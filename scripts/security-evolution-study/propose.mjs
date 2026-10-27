import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASELINE_SKILL } from './protocol.mjs';

/** Production width-one proposer, confined to one non-executable skill file. */
export async function proposeCurrentWidthOne({ protocol, prompt, nativeCall }) {
  const { parseEvolutionConfig } = await import('../../packages/core/dist/improvement/config.js');
  const { snapshotEvolutionSource } = await import('../../packages/core/dist/improvement/registry.js');
  const { proposeEvolutionEdits } = await import('../../packages/core/dist/improvement/rewrite.js');
  const dir = mkdtempSync(join(tmpdir(), '0-source-pilot-proposal-'));
  const sourceRoot = join(dir, 'source'); mkdirSync(sourceRoot);
  writeFileSync(join(sourceRoot, 'skill.txt'), BASELINE_SKILL, { mode: 0o600 });
  let observed = null;
  try {
    // Placeholder private inputs satisfy the production proposer's corpus contract
    // without disclosing any actual private source/identity/answer. This helper
    // never invokes its deterministic guest evaluator or relaxes production gates.
    const cases = ['development', 'held-out', 'negative-control'].flatMap(lane => [0, 1, 2].map(index => ({ id: `${lane}-${index}`, lane, input: { lane, index }, expected: null })));
    const config = parseEvolutionConfig({ schemaVersion: 1, sourceRoot, storePath: join(dir, 'store'), image: 'node:24', sourcePaths: ['skill.txt'], editablePaths: ['skill.txt'], kind: 'skill', command: ['node', '-e', ''], cases, repeats: 2, maxIterations: 1, maxModelTurns: 1, maxModelCostUsd: protocol.perCallCeilingUsd, maxEvaluationCostUsd: 1, computeUsdPerSecond: .000001, maxOutputBytes: 4096, maxSourceBytes: 8192, maxChangedBytes: protocol.maxProposalBytes, model: protocol.model, objective: 'Improve only the bounded prototype-pollution source-review skill; preserve JSON vulnerable/sink/reason evidence output.', allowModelSourceAccess: true, autoPromote: false, promotionPolicy: { minimumCases: 3 } });
    const snapshot = await snapshotEvolutionSource(config);
    const proposal = await proposeEvolutionEdits(snapshot, config, prompt, {
      modelIdentity: () => ({ provider: protocol.provider, model: protocol.model, pricingModel: 'gpt-4.1-mini' }),
      model: async (system, messages, tools, signal) => {
        observed = await nativeCall(system, messages, tools, signal);
        return observed;
      },
    });
    const edit = proposal.edits.find(e => e.path === 'skill.txt');
    return { text: JSON.stringify({ skill: edit?.content ?? BASELINE_SKILL }), usage: observed?.usage ?? null, completed: true, providerRaw: observed?.providerRaw };
  } catch {
    // Any consumed generation cost is still returned to the enclosing reservation.
    return { text: '{}', usage: observed?.usage ?? null, completed: false, providerRaw: observed?.providerRaw };
  } finally {
    const writable = path => { chmodSync(path, 0o700); for (const item of readdirSync(path, { withFileTypes: true })) if (item.isDirectory()) writable(join(path, item.name)); };
    writable(dir); rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
