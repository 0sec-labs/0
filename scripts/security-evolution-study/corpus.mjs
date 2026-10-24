import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const digest = value => `sha256:${createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex')}`;
export const FAMILIES = [
  { family: 'json5', lane: 'development', vulnerable: '2.2.1', fixed: '2.2.2', ghsa: 'GHSA-9c47-m6qq-7p4h', files: ['lib/parse.js'], sinks: ['push', 'Object.defineProperty', 'parent'] },
  { family: 'minimist', lane: 'development', vulnerable: '1.2.5', fixed: '1.2.6', ghsa: 'GHSA-xvch-5gv4-984h', files: ['index.js'], sinks: ['setKey', '__proto__', 'constructor'] },
  { family: 'y18n', lane: 'selection', vulnerable: '4.0.0', fixed: '4.0.1', ghsa: 'GHSA-c4w7-xm78-47vh', files: ['index.js'], sinks: ['__', 'locale', 'cache'] },
  { family: 'qs', lane: 'selection', vulnerable: '6.10.2', fixed: '6.10.3', ghsa: 'GHSA-hrpp-h998-j3pp', files: ['lib/parse.js', 'lib/utils.js'], sinks: ['parseObject', '__proto__', 'parseKeys'] },
  { family: 'hoek', lane: 'final', vulnerable: '5.0.2', fixed: '5.0.3', ghsa: 'GHSA-jp4x-w63m-7wgm', files: ['lib/index.js'], sinks: ['merge', 'key', '__proto__'] },
  { family: 'lodash', lane: 'final', vulnerable: '4.17.18', fixed: '4.17.19', ghsa: 'GHSA-p6mc-m468-83gw', files: ['_baseSet.js', '_baseZipObject.js', 'zipObjectDeep.js'], sinks: ['baseSet', 'zipObjectDeep', '__proto__'] },
];
const CLEAN = [
  { lane: 'development', source: 'module.exports = function parse(input) { return JSON.parse(input); };\n', rationale: 'JSON.parse produces data properties and never copies input keys into an existing prototype.' },
  { lane: 'selection', source: 'module.exports = function record(entries) { return Object.fromEntries(entries); };\n', rationale: 'Object.fromEntries creates own data properties, including an own __proto__ property.' },
  { lane: 'final', source: 'module.exports = function record(input) { const result = Object.create(null); for (const key of Object.keys(input)) result[key] = input[key]; return result; };\n', rationale: 'Destination has a null prototype and assignment cannot mutate Object.prototype.' },
];

export function extractTarFiles(gzip, wanted) {
  const tar = gunzipSync(gzip, { maxOutputLength: 16 * 1024 * 1024 });
  const found = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > 8 * 1024 * 1024 || offset + 512 + size > tar.length) throw new Error('invalid tar entry');
    const type = header[156];
    if (wanted.includes(path)) {
      if (type !== 0 && type !== 48) throw new Error('selected source is not a regular tar entry');
      if (found.has(path) || size > 128 * 1024) throw new Error('duplicate or oversized selected source');
      found.set(path, new TextDecoder('utf-8', { fatal: true }).decode(tar.subarray(offset + 512, offset + 512 + size)));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (wanted.some(path => !found.has(path))) throw new Error(`missing selected source: ${wanted.filter(path => !found.has(path)).join(',')}`);
  return wanted.map(path => ({ path: path.slice('package/'.length), source: found.get(path) }));
}
function versionInRange(version, range) {
  const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  return range.split(',').every(part => {
    const match = part.trim().match(/^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)$/);
    if (!match) throw new Error('unsupported advisory version range; independent curation required');
    const c = compare(version, match[2]);
    return ({ '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0 })[match[1] ?? '='];
  });
}
async function limitedFetch(url, binary = false) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['registry.npmjs.org', 'api.github.com'].includes(parsed.hostname)) throw new Error('untrusted corpus URL');
  const response = await fetch(url, { redirect: 'error', headers: { 'User-Agent': '0sec-bounded-offline-study', Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`corpus fetch failed ${response.status}: ${parsed.hostname}${parsed.pathname}`);
  const chunks = []; let total = 0;
  for await (const chunk of response.body) { total += chunk.length; if (total > 8 * 1024 * 1024) throw new Error('corpus response exceeds byte cap'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  return binary ? bytes : JSON.parse(bytes.toString('utf8'));
}

/** Reference labels predate this study; neither candidate nor proposer creates expected answers. */
export async function preparePublicCorpus({ fetchResource = limitedFetch } = {}) {
  const cases = [];
  const advisories = [];
  for (const family of FAMILIES) {
    const advisory = await fetchResource(`https://api.github.com/advisories/${family.ghsa}`);
    if (advisory.ghsa_id !== family.ghsa || advisory.withdrawn_at || !advisory.vulnerabilities?.some(v => v.package?.ecosystem === 'npm' && v.package.name === family.family)) throw new Error(`invalid upstream advisory ${family.ghsa}`);
    const matching = advisory.vulnerabilities.find(v => v.package?.name === family.family && v.first_patched_version === family.fixed && versionInRange(family.vulnerable, v.vulnerable_version_range) && !versionInRange(family.fixed, v.vulnerable_version_range));
    if (!matching) throw new Error('curated vulnerable/fixed versions no longer match upstream advisory');
    advisories.push({ id: family.ghsa, url: advisory.html_url, advisoryDigest: digest(advisory), publishedAt: advisory.published_at, updatedAt: advisory.updated_at, vulnerabilities: advisory.vulnerabilities });
    for (const label of ['vulnerable', 'fixed']) {
      const version = family[label];
      const metadata = await fetchResource(`https://registry.npmjs.org/${family.family}/${version}`);
      if (metadata.name !== family.family || metadata.version !== version || !metadata.dist?.integrity?.startsWith('sha512-')) throw new Error('package identity/integrity unavailable');
      const gzip = await fetchResource(metadata.dist.tarball, true);
      const integrity = `sha512-${createHash('sha512').update(gzip).digest('base64')}`;
      if (integrity !== metadata.dist.integrity) throw new Error('registry tarball integrity mismatch');
      const files = extractTarFiles(gzip, family.files.map(path => `package/${path}`));
      const source = files.map((file, index) => `// source-unit-${index + 1}\n${file.source}`).join('\n');
      cases.push({ id: digest([family.family, version, source]), family: family.family, lane: family.lane, label, labelBasis: 'upstream-advisory-version-pair', advisory: family.ghsa, package: family.family, version, tarballIntegrity: integrity, tarballDigest: digest(gzip), sourceDigest: digest(source), files: files.map(file => ({ path: file.path, digest: digest(file.source) })), sinks: family.sinks, source });
    }
  }
  for (const clean of CLEAN) cases.push({ id: digest(clean.source), family: `structural-clean-${clean.lane}`, lane: clean.lane, label: 'clean', labelBasis: 'deterministic-language-semantics-control', labelRationale: clean.rationale, sourceDigest: digest(clean.source), sinks: [], source: clean.source });
  const corpus = { schemaVersion: 1, scope: 'bounded JavaScript prototype-pollution source review; fixed means fixed for the selected advisory, not globally vulnerability-free', contamination: 'public historical advisories; no claim of post-training secrecy or security-generalization', advisories, cases };
  return { ...corpus, digest: digest(corpus) };
}

export function admitCorpus(corpus) {
  if (corpus.schemaVersion !== 1 || !Array.isArray(corpus.cases) || corpus.cases.length > 100 || corpus.cases.length < 9) throw new Error('invalid finite corpus');
  const { digest: claimed, ...rest } = corpus;
  if (claimed !== digest(rest)) throw new Error('corpus digest mismatch');
  const seen = new Set(); const sources = new Map(); const families = new Map();
  for (const c of corpus.cases) {
    if (!/^[a-z0-9-]{1,64}$/.test(c.family) || !['development', 'selection', 'final'].includes(c.lane) || !['vulnerable', 'fixed', 'clean'].includes(c.label) || typeof c.source !== 'string' || Buffer.byteLength(c.source) > 128 * 1024 || c.sourceDigest !== digest(c.source) || seen.has(c.id)) throw new Error('invalid/duplicate source case');
    seen.add(c.id);
    if (families.has(c.family) && families.get(c.family) !== c.lane) throw new Error('family leakage across lanes');
    if (sources.has(c.sourceDigest) && sources.get(c.sourceDigest) !== c.lane) throw new Error('renamed source leakage across lanes');
    families.set(c.family, c.lane); sources.set(c.sourceDigest, c.lane);
    if (c.label !== 'clean' && (!corpus.advisories.some(a => a.id === c.advisory) || !c.tarballIntegrity?.startsWith('sha512-'))) throw new Error('independent upstream label provenance missing');
  }
  for (const lane of ['development', 'selection', 'final']) for (const label of ['vulnerable', 'fixed', 'clean']) if (!corpus.cases.some(c => c.lane === lane && c.label === label)) throw new Error(`missing ${lane} ${label} control`);
  return corpus;
}

/** Never pass label, advisory, version or private-lane scores to the proposer. */
export function sourceTask(c) { return { source: c.source, sourceDigest: c.sourceDigest }; }
export function developmentCases(corpus) { return corpus.cases.filter(c => c.lane === 'development'); }
