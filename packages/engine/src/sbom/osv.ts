/**
 * Check an SBOM's components against the public OSV database (https://osv.dev). The SBOM and the responses are untrusted
 * text: package URLs are validated and bounded, and every string that comes back is cleaned and truncated before use.
 */
export interface Advisory {
  /** The component's package URL. */
  purl: string;
  id: string;
  aliases: string[];
  summary: string;
  severity?: string;
  /** Versions that fix it, when the advisory says. */
  fixed: string[];
}
export interface OsvOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Most advisories whose details are fetched; the rest are still counted. */
  maxDetails?: number;
}

const BATCH = 1000;
const MAX_COMPONENTS = 20_000;
const MAX_DETAILS = 500;
const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (value: unknown, max: number): string => typeof value === "string" ? value.replace(CONTROL, "").trim().slice(0, max) : "";
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function post(fetcher: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`OSV answered ${response.status}`);
  return response.json();
}
async function get(fetcher: typeof fetch, url: string): Promise<unknown> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`OSV answered ${response.status}`);
  return response.json();
}

export async function checkBomAgainstOsv(bom: unknown, options: OsvOptions = {}): Promise<{ checked: number; advisories: Advisory[]; withoutDetails: number }> {
  const fetcher = options.fetch ?? fetch;
  const base = (options.baseUrl ?? "https://api.osv.dev").replace(/\/$/, "");
  const components = isObject(bom) && Array.isArray(bom.components) ? bom.components : [];
  const purls = [...new Set(components.map(component => isObject(component) ? component.purl : undefined)
    .filter((purl): purl is string => typeof purl === "string" && /^pkg:[a-z]+\/\S{1,380}$/.test(purl)))].slice(0, MAX_COMPONENTS);
  if (!purls.length) throw new Error("The SBOM has no components with a package URL to check.");

  const hits = new Map<string, Set<string>>(); // advisory id -> purls it affects
  for (let start = 0; start < purls.length; start += BATCH) {
    const slice = purls.slice(start, start + BATCH);
    const answer = await post(fetcher, `${base}/v1/querybatch`, { queries: slice.map(purl => ({ package: { purl } })) });
    const results = isObject(answer) && Array.isArray(answer.results) ? answer.results : [];
    results.forEach((result, index) => {
      const vulns = isObject(result) && Array.isArray(result.vulns) ? result.vulns : [];
      for (const vuln of vulns) {
        const id = isObject(vuln) ? clean(vuln.id, 80) : "";
        if (id) hits.set(id, (hits.get(id) ?? new Set()).add(slice[index]!));
      }
    });
  }

  const ids = [...hits.keys()].sort();
  const detailIds = ids.slice(0, options.maxDetails ?? MAX_DETAILS);
  const details = new Map<string, { aliases: string[]; summary: string; severity?: string; fixed: string[] }>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, detailIds.length) }, async () => {
    while (next < detailIds.length) {
      const id = detailIds[next++]!;
      try {
        const record = await get(fetcher, `${base}/v1/vulns/${encodeURIComponent(id)}`);
        if (!isObject(record)) continue;
        const database = isObject(record.database_specific) ? record.database_specific : {};
        const fixed = new Set<string>();
        for (const affected of Array.isArray(record.affected) ? record.affected : []) {
          for (const range of isObject(affected) && Array.isArray(affected.ranges) ? affected.ranges : []) {
            for (const event of isObject(range) && Array.isArray(range.events) ? range.events : []) if (isObject(event) && typeof event.fixed === "string") fixed.add(clean(event.fixed, 60));
          }
        }
        details.set(id, {
          aliases: (Array.isArray(record.aliases) ? record.aliases : []).map(alias => clean(alias, 80)).filter(Boolean).slice(0, 8),
          summary: clean(record.summary, 300) || clean(record.details, 300),
          ...(clean(database.severity, 20) ? { severity: clean(database.severity, 20) } : {}),
          fixed: [...fixed].slice(0, 5),
        });
      } catch { /* an advisory whose details cannot be read is still reported by id */ }
    }
  }));

  const advisories: Advisory[] = [];
  for (const id of ids) {
    const detail = details.get(id) ?? { aliases: [], summary: "", fixed: [] };
    for (const purl of [...hits.get(id)!].sort()) advisories.push({ purl, id, aliases: detail.aliases, summary: detail.summary, ...(detail.severity ? { severity: detail.severity } : {}), fixed: detail.fixed });
  }
  return { checked: purls.length, advisories, withoutDetails: ids.length - detailIds.length + detailIds.filter(id => !details.has(id)).length };
}
