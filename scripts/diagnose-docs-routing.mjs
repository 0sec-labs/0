// Read-only diagnostics for the public docs domain. Never print credentials.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('Cloudflare account and token are required.');
async function get(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`${path}: ${data.errors?.map(e => e.message).join(', ') || response.status}`);
  return data.result;
}
const projects = await get(`/accounts/${account}/pages/projects`);
const owners = projects.filter(project => project.domains?.includes('docs.0.security'));
console.log('Pages projects serving docs.0.security:', owners.map(project => ({ name: project.name, productionBranch: project.production_branch })));
if (owners.length !== 1) throw new Error(`Expected one Pages project owning docs.0.security; found ${owners.length}. Fix the domain association before deploying.`);
const project = owners[0];
if (!project.production_branch) throw new Error("The docs project has no production branch.");
const domains = await get(`/accounts/${account}/pages/projects/${project.name}/domains`);
console.log('Pages custom domain:', domains.filter(d => d.name === 'docs.0.security').map(d => ({ name: d.name, status: d.status })));
if (process.env.GITHUB_OUTPUT) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(process.env.GITHUB_OUTPUT, `project_name=${project.name}\nproduction_branch=${project.production_branch}\n`);
}
try {
  const zones = await get('/zones?name=0.security');
  for (const zone of zones) {
    const records = await get(`/zones/${zone.id}/dns_records?name=docs.0.security`);
    console.log('Docs DNS:', records.map(r => ({ type: r.type, name: r.name, content: r.content, proxied: r.proxied })));
    const routes = await get(`/zones/${zone.id}/workers/routes`);
    console.log('Docs worker routes:', routes.filter(r => r.pattern.includes('docs.0.security')).map(r => ({ pattern: r.pattern, script: r.script })));
  }
} catch (error) { console.log(`Zone diagnostics unavailable: ${error.message}`); }
