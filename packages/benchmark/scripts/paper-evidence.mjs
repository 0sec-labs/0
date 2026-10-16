// Offline publication only. No scanner imports, network access or model calls.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, relative, dirname, isAbsolute } from 'node:path';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const unique = xs => [...new Set(xs)];
const median = xs => {
  if (!xs.length || xs.some(x => !Number.isFinite(x))) return null;
  const s = [...xs].sort((a,b) => a-b); const m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
};
const jsonl = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

export function loadManifest(root, manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.inputs)) throw new Error('Unsupported evidence manifest');
  const result = {};
  for (const input of manifest.inputs) {
    const path = resolve(root, input.path); const rel = relative(root,path);
    if (isAbsolute(input.path) || rel.startsWith('..') || result[input.id]) throw new Error('Invalid or duplicate manifest input');
    const bytes = readFileSync(path);
    if (digest(bytes) !== input.sha256) throw new Error(`Evidence hash mismatch: ${input.id}`);
    result[input.id] = input.path.endsWith('.jsonl') ? jsonl(bytes.toString()) : input.path.endsWith('.json') ? JSON.parse(bytes) : bytes.toString();
  }
  return result;
}

export function compareCohorts(parent, child) {
  if (parent.asOf !== child.asOf || parent.protocol !== child.protocol) return 'incompatible cohorts';
  if (!Array.isArray(parent.ids) || !Array.isArray(child.ids)) return 'unknown denominator';
  return child.ids.every(id => parent.ids.includes(id)) ? 'compatible subset' : 'invalid subset';
}

export function summarizeXbow(data) {
  const bb = unique(data.solved.blackBox); const wb = unique(data.solved.whiteBox);
  const union = unique([...bb,...wb]); const warnings = ['Complete failed-attempt denominator, source/evaluator revision and supplier charges are unknown.'];
  for (const [key, ids] of Object.entries({blackBox:bb,whiteBox:wb,aggregate:union})) {
    if (data.counts[key] !== ids.length) warnings.push(`Declared ${key} count differs from retained IDs.`);
  }
  const attempts = [];
  for (const mode of ['blackBox','whiteBox']) for (const [target, entries] of Object.entries(data.sources[mode] ?? {})) {
    for (const entry of entries) attempts.push(`${target}:${mode}:${entry.runId}:${entry.artifact}`);
  }
  const duplicateAttempts = attempts.length - unique(attempts).length;
  if (duplicateAttempts) warnings.push(`${duplicateAttempts} duplicate success-receipt references.`);
  if (Object.values(data.perModel).some(m => m.solved > bb.length)) warnings.push('Per-model union exceeds black-box union: the model summary includes both modes, not a black-box subset.');
  return { blackBox:bb.length, whiteBox:wb.length, union:union.length, duplicateAttempts, warnings };
}

export function summarizeAB(data) {
  const arms = Object.fromEntries(['control','treatment'].map(arm => [arm, {
    runs:data[arm].length, passed:data[arm].filter(r=>r.passed && r.flagFound).length,
    failed:data[arm].filter(r=>!r.passed || !r.flagFound).length,
    cost:median(data[arm].map(r=>r.estimatedCostUsd)), durationMs:median(data[arm].map(r=>r.durationMs)),
  }]));
  const change = arms.control.cost !== null && arms.control.cost > 0 && arms.treatment.cost !== null
    ? 100*(arms.treatment.cost/arms.control.cost-1) : null;
  return {arms,change,caveats:data.caveats ?? [],warnings:change === null ? ['Cost is missing or incomparable.'] : []};
}

export function auditRouter(rows, meta) {
  const positives=rows.filter(r=>r.label===1).length; const negatives=rows.filter(r=>r.label===0).length;
  const origins={}; const groups=new Map();
  for(const row of rows) {
    origins[row.label_source ?? 'unknown']=(origins[row.label_source ?? 'unknown'] ?? 0)+1;
    const id=row.source?.match(/XBEN-\d+-\d+/)?.[0] ?? row.source ?? 'unknown';
    const group=groups.get(id) ?? []; group.push(row.label); groups.set(id,group);
  }
  const warnings=['Outcome-level weak supervision does not establish individual-finding truth.','Row-wise CV is not a group-held-out generalization result; efficacy claims omitted.'];
  if(meta.n_samples!==rows.length || meta.n_tp!==positives || meta.n_fp!==negatives) warnings.push('Dataset and model metadata counts differ.');
  // Pooled always-positive baseline, explicitly not a reproduced identical-fold CV.
  return {rows:rows.length,positives,negatives,origins,duplicateTexts:rows.length-unique(rows.map(r=>r.text)).length,
    groups:groups.size,repeatedGroups:[...groups.values()].filter(g=>g.length>1).length,
    mixedLabelGroups:[...groups.values()].filter(g=>new Set(g).size>1).length,
    pooledAlwaysPositiveF1:2*positives/(2*positives+negatives),recordedRowCvF1:meta.cv_metrics.mean_f1,warnings};
}

export function summarizeCybergym(rows) {
  const ids=rows.map(r=>r.taskId); const passed=rows.filter(r=>r.passed===true).length;
  return {rows:rows.length,uniqueTasks:unique(ids).length,passed,failed:rows.length-passed,
    stablePass:rows.filter(r=>r.stablePass===true).length,duplicateTasks:rows.length-unique(ids).length,
    warnings:['One retained campaign; no matched self-evolution arm.','Source revision and supplier charges are unknown.',...(ids.some(id=>!id)?['Missing target identities.']:[])]};
}

export function generate(root=repoRoot) {
  const manifest=JSON.parse(readFileSync(resolve(root,'docs/paper/evidence/manifest.json'),'utf8'));
  const claims=JSON.parse(readFileSync(resolve(root,'docs/paper/evidence/claim-map.json'),'utf8'));
  const data=loadManifest(root,manifest);
  for(const claim of claims.claims) for(const id of claim.inputs) if(!(id in data)) throw new Error(`Unknown claim input: ${id}`);
  const x=summarizeXbow(data.xbow); const ab=summarizeAB(data.ab); const router=auditRouter(data.router,data.routerMeta); const cg=summarizeCybergym(data.cybergym);
  const rows=[
    ['XBOW retained May 4 union',`${x.blackBox} black-box / ${x.whiteBox} white-box / ${x.union} any-mode successes`,'Union over repeated runs; failed-attempt denominator unknown.'],
    ['May 6 ledger headline','Suppressed','Different snapshot; model union is not black-box-only or single-shot.'],
    ['Reasoning A/B control',`${ab.arms.control.passed}/${ab.arms.control.runs} success; median estimated USD ${ab.arms.control.cost ?? 'unknown'}`,'One target; missing model/source identity; target parser errors.'],
    ['Reasoning A/B treatment',`${ab.arms.treatment.passed}/${ab.arms.treatment.runs} success; median estimated USD ${ab.arms.treatment.cost ?? 'unknown'}`,'Quality unchanged; not independently measured provider charges.'],
    ['Reasoning A/B cost change',ab.change===null?'unknown':`${ab.change.toFixed(2)}%`,'Preliminary one-target observation; no generalization inference.'],
    ['CyberGym July 4',`${cg.passed}/${cg.rows} successes; ${cg.failed} failures; ${cg.uniqueTasks} unique tasks`,'No matched evolution comparison; costs unknown.'],
  ];
  const table=(headers,rows)=>'| '+headers.join(' | ')+' |\n| '+headers.map(()=>'---').join(' | ')+' |\n'+rows.map(row=>'| '+row.map(c=>String(c).replaceAll('|','\\|').replaceAll('\n',' ')).join(' | ')+' |').join('\n');
  const cohortCompatibility=compareCohorts(manifest.inputs.find(i=>i.id==='xbow'),manifest.inputs.find(i=>i.id==='ledger'));
  const warnings=[`May 4 input versus May 6 ledger: ${cohortCompatibility}.`,...x.warnings,...ab.warnings,...router.warnings,...cg.warnings,...manifest.inputs.flatMap(i=>i.missingProvenance.map(p=>`${i.id}: missing ${p}.`))];
  const sources=manifest.inputs.map(i=>[i.id,i.path,i.sha256,i.protocol,i.asOf??'unknown']);
  const provenanceRows=claims.claims.map(c=>[c.claim,c.status,c.inputs.join(', '),c.limits]);
  const md=`# Generated publication evidence\n\nAudit date: ${manifest.reviewedAt}. Unsubmitted. Offline, immutable inputs; no new measurements.\n\n## Historical observations\n\n${table(['Cohort','Recorded outcome','Qualification'],rows)}\n\nAll recorded CyberGym failures and A/B target errors remain part of the evidence. April triage summaries in evaluation.md retain their regressions; complete raw run/cost records are missing, so efficacy is unqualified.\n\n## Classifier label and leakage audit\n\n${table(['Measure','Value'],Object.entries(router).filter(([k])=>!['warnings','origins'].includes(k)).map(([k,v])=>[k,typeof v==='number'?Number(v.toFixed(10)):v]))}\n\nLabel origins: ${JSON.stringify(router.origins)}. All labels are outcome-level weak supervision. The always-positive F1 above is pooled, not identical-fold CV. The stored row-CV metric is reported for audit only; no finding-precision, generalization or router-efficacy claim is made. No retraining/deployment occurred.\n\n## Claim-to-artifact map\n\n${table(['Claim','Status','Inputs','Limits'],provenanceRows)}\n\nArchitecture/source presence, synthetic correctness and empirical efficacy are separate. Source input hashes establish the audited code bytes, not the execution identity of historical runs. Synthetic regression tests validate contracts; they supply no unseen-security efficacy estimate.\n\n## Missing or incompatible evidence\n\n${warnings.map(w=>'- '+w).join('\n')}\n\n${ab.caveats.map(w=>'- '+w).join('\n')}\n\n## Immutable inputs\n\n${table(['ID','Path','SHA-256','Protocol','As of'],sources)}\n`;
  const escape=val=>String(val).replace(/[\\&%$#_{}~^]/g,c=>({'\\':'\\textbackslash{}','&':'\\&','%':'\\%','$':'\\$','#':'\\#','_':'\\_','{':'\\{','}':'\\}','~':'\\textasciitilde{}','^':'\\textasciicircum{}'}[c]));
  const texRows=rows.map(r=>r.map(escape).join(' & ')+' \\\\').join('\n');
  const claimTex=provenanceRows.map(r=>[r[0],r[1],r[2]+'; '+r[3]].map(escape).join(' & ')+' \\\\').join('\n');
  const tex=`% Generated by packages/benchmark/scripts/paper-evidence.mjs; do not hand-edit.\n\\subsection{Audited historical observations (${manifest.reviewedAt})}\nUnsubmitted; no new measurements. These are qualified historical observations, not autonomous-evolution efficacy.\n\\begin{center}\\small\n\\begin{tabular}{p{0.23\\linewidth}p{0.32\\linewidth}p{0.35\\linewidth}}\n\\toprule\nCohort & Recorded outcome & Qualification \\\\\n\\midrule\n${texRows}\n\\bottomrule\n\\end{tabular}\n\\end{center}\nThe router dataset has ${router.rows} outcome-labelled rows, ${router.duplicateTexts} exact text duplicates and ${router.groups} target/source groups (${router.mixedLabelGroups} mixed-label). Labels are weak supervision; finding precision and classifier generalization are not established. The pooled always-positive F1 is ${router.pooledAlwaysPositiveF1.toFixed(5)}; row-wise CV efficacy is omitted.\\par\nSource/architecture presence and synthetic correctness tests remain separate from empirical efficacy. Complete raw April run/cost denominators, historical source identity and supplier charges are missing.\\par\n\\subsection{Claim-to-artifact qualification}\n\\begin{center}\\small\n\\begin{tabular}{p{0.22\\linewidth}p{0.22\\linewidth}p{0.46\\linewidth}}\n\\toprule\nClaim & Status & Input IDs and limits \\\\\n\\midrule\n${claimTex}\n\\bottomrule\n\\end{tabular}\n\\end{center}\nInput IDs resolve to SHA-256 hashes and provenance in the packaged evidence manifest.\n`;
  const out=resolve(root,'docs/paper/generated');mkdirSync(out,{recursive:true});
  writeFileSync(resolve(out,'evidence-tables.md'),md);writeFileSync(resolve(out,'evidence-tables.tex'),tex);
  writeFileSync(resolve(out,'evidence-audit.json'),JSON.stringify({version:1,manifestSha256:digest(JSON.stringify(manifest)),xbow:x,ab,router,cybergym:cg,warnings},null,2)+'\n');
  return {rows,warnings};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=generate();console.log(`Generated offline evidence tables; ${result.warnings.length} qualification flags retained.`);
}
