import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'docs/dist');
const args = process.argv.slice(2);
const revision = process.env.GITHUB_SHA;
const errors = [];
const pages = new Map();
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.html')) {
      const url = '/' + relative(dist, path).replaceAll('\\', '/').replace(/index\.html$/, '');
      pages.set(url, await readFile(path, 'utf8'));
    }
  }
}
await walk(dist);
function route(url) { return url.endsWith('/') || url.endsWith('.html') ? url : url + '/'; }
async function checkLink(href, source) {
  const url = new URL(href.replaceAll('&amp;', '&'), 'https://docs.0.security' + source);
  if (url.origin !== 'https://docs.0.security') return;
  const target = route(decodeURIComponent(url.pathname));
  if (!pages.has(target)) {
    try { await access(resolve(dist, '.' + decodeURIComponent(url.pathname))); }
    catch { errors.push(`${source}: missing ${href}`); }
  } else if (url.hash) {
    const id = decodeURIComponent(url.hash.slice(1));
    const ids = [...pages.get(target).matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
    if (!ids.includes(id)) errors.push(`${source}: missing anchor ${href}`);
  }
}
for (const [url, html] of pages) {
  for (const match of html.matchAll(/\bhref=["']([^"']+)["']/g)) {
    if (url === '/404.html' && match[1] === 'https://docs.0.security/404/') continue;
    if (!/^(mailto:|tel:|javascript:|data:)/.test(match[1])) await checkLink(match[1], url);
  }
}
const readme = await readFile(resolve(root, 'README.md'), 'utf8');
const docsLinks = [...new Set([...readme.matchAll(/https:\/\/docs\.0\.security\/[^\s)"<>]*/g)].map(m => m[0]))];
for (const href of docsLinks) await checkLink(href, '/');
if (errors.length) throw new Error(`Broken docs links (${errors.length}):\n${errors.join('\n')}`);
console.log(`Checked ${pages.size} built pages and ${docsLinks.length} README documentation links.`);
if (args.includes('--write-marker')) {
  if (!revision) throw new Error('GITHUB_SHA is required to write the deployment marker.');
  await writeFile(resolve(dist, 'deployment.json'), JSON.stringify({ revision }) + '\n');
}
if (args.includes('--live')) {
  if (!revision) throw new Error('GITHUB_SHA is required to verify the deployment.');
  const base = process.env.DOCS_SITE_URL || 'https://docs.0.security';
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetch(`${base}/deployment.json?revision=${revision}`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
      if (!response.ok || (await response.json()).revision !== revision) throw new Error('Custom domain is not serving the deployed revision.');
      for (const href of docsLinks) {
        const url = new URL(href); url.searchParams.set('revision', revision);
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`${href}: HTTP ${response.status}`);
      }
      console.log(`Verified ${base} serves ${revision} and all README documentation links.`);
      process.exit(0);
    } catch (error) {
      if (attempt === 11) throw error;
      console.log(`Waiting for public docs deployment (${attempt + 1}/12): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}
