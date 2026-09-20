import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";

const execFileAsync = promisify(execFile);
type Ecosystem = "npm" | "pnpm" | "cargo" | "pypi";

interface Finding {
  package?: string;
  severity?: string;
  advisory?: string;
  fix?: string;
}

interface ScanResult {
  ecosystem: Ecosystem;
  command: string;
  exitCode: number;
  findings: Finding[];
  raw?: unknown;
  error?: string;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function detect(cwd: string): Promise<Ecosystem> {
  if (await exists(`${cwd}/pnpm-lock.yaml`)) return "pnpm";
  if (await exists(`${cwd}/package-lock.json`) || await exists(`${cwd}/npm-shrinkwrap.json`)) return "npm";
  if (await exists(`${cwd}/Cargo.lock`) || await exists(`${cwd}/Cargo.toml`)) return "cargo";
  if (await exists(`${cwd}/uv.lock`) || await exists(`${cwd}/poetry.lock`) || await exists(`${cwd}/requirements.txt`)) return "pypi";
  throw new Error("No supported dependency manifest found (pnpm/npm, Cargo, or Python).");
}

function parseAudit(ecosystem: Ecosystem, value: string): Finding[] {
  try {
    const data = JSON.parse(value) as Record<string, unknown>;
    if (ecosystem === "npm" || ecosystem === "pnpm") {
      const entries = data.vulnerabilities ?? data.advisories;
      if (!entries || typeof entries !== "object") return [];
      return Object.entries(entries).map(([pkg, raw]) => {
        const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const via = Array.isArray(item.via) && item.via[0] && typeof item.via[0] === "object" ? item.via[0] as Record<string, unknown> : {};
        const fix = item.fixAvailable;
        const fixVersion = fix && typeof fix === "object" ? (fix as Record<string, unknown>).version : undefined;
        return { package: pkg, severity: typeof item.severity === "string" ? item.severity : undefined, advisory: typeof via.title === "string" ? via.title : typeof via.url === "string" ? via.url : typeof item.title === "string" ? item.title : undefined, fix: typeof fixVersion === "string" ? fixVersion : fix ? "available" : undefined };
      });
    }
    if (ecosystem === "cargo") {
      const vulnerabilities = data.vulnerabilities;
      const list = vulnerabilities && typeof vulnerabilities === "object" ? (vulnerabilities as Record<string, unknown>).list : undefined;
      if (!Array.isArray(list)) return [];
      return list.map((raw) => {
        const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const advisory = item.advisory && typeof item.advisory === "object" ? item.advisory as Record<string, unknown> : {};
        const pkg = item.package && typeof item.package === "object" ? item.package as Record<string, unknown> : {};
        const versions = item.versions && typeof item.versions === "object" ? item.versions as Record<string, unknown> : {};
        return { package: typeof pkg.name === "string" ? pkg.name : undefined, severity: typeof advisory.cvss === "string" ? advisory.cvss : typeof advisory.severity === "string" ? advisory.severity : undefined, advisory: typeof advisory.id === "string" ? advisory.id : typeof advisory.title === "string" ? advisory.title : undefined, fix: Array.isArray(versions.patched) ? versions.patched.join(", ") : undefined };
      });
    }
    const dependencies = data.dependencies;
    if (!Array.isArray(dependencies)) return [];
    return dependencies.flatMap((raw) => {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const vulns = Array.isArray(item.vulns) ? item.vulns : [];
      return vulns.map((vuln) => {
        const finding = vuln && typeof vuln === "object" ? vuln as Record<string, unknown> : {};
        return { package: typeof item.name === "string" ? item.name : undefined, severity: typeof finding.severity === "string" ? finding.severity : undefined, advisory: typeof finding.id === "string" ? finding.id : undefined, fix: Array.isArray(finding.fix_versions) ? finding.fix_versions.join(", ") : undefined };
      });
    });
  } catch { return []; }
}

async function run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const failure = error && typeof error === "object" ? error as Record<string, unknown> : {};
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: typeof failure.stdout === "string" ? failure.stdout : "", stderr: typeof failure.stderr === "string" ? failure.stderr : failure.message instanceof String ? failure.message.toString() : "" };
  }
}
export async function scanDependencies(cwd = process.cwd(), ecosystem?: Ecosystem): Promise<ScanResult> {
  const kind = ecosystem ?? await detect(cwd);
  const command = kind === "pnpm" ? "pnpm audit --json" : kind === "npm" ? "npm audit --json" : kind === "cargo" ? "cargo audit --json" : "pip-audit --format=json";
  const [binary, ...args] = command.split(" ");
  const result = await run(binary, args, cwd);
  const output = result.stdout || result.stderr;
  return { ecosystem: kind, command, exitCode: result.code, findings: parseAudit(kind, output), raw: (() => { try { return JSON.parse(output); } catch { return undefined; } })(), error: result.code && !output ? `Unable to run ${command}` : undefined };
}

async function fixDependencies(cwd: string, ecosystem?: Ecosystem): Promise<{ ecosystem: Ecosystem; command: string; exitCode: number; output: string }> {
  const kind = ecosystem ?? await detect(cwd);
  const command = kind === "pnpm" ? "pnpm audit --fix" : kind === "npm" ? "npm audit fix" : kind === "cargo" ? "cargo update" : "pip-audit --fix";
  const [binary, ...args] = command.split(" ");
  const result = await run(binary, args, cwd);
  return { ecosystem: kind, command, exitCode: result.code, output: result.stdout || result.stderr };
}

export function registerDepsCommand(program: Command): void {
  const deps = program.command("deps").description("Scan and remediate project dependencies for known vulnerabilities");
  deps.command("scan")
    .description("Run the native advisory database scanner for the current project")
    .option("--cwd <path>", "Project directory", process.cwd())
    .option("--ecosystem <name>", "Override detected ecosystem: npm, pnpm, cargo, pypi")
    .option("--json", "Emit machine-readable output")
    .action(async (opts: { cwd: string; ecosystem?: Ecosystem; json?: boolean }) => {
      const result = await scanDependencies(opts.cwd, opts.ecosystem);
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${result.ecosystem}: ${result.findings.length} vulnerable dependencies`);
        for (const finding of result.findings) console.log(`- ${finding.package ?? "unknown"}${finding.severity ? ` [${finding.severity}]` : ""}${finding.advisory ? `: ${finding.advisory}` : ""}${finding.fix ? ` (fix: ${finding.fix})` : ""}`);
        if (result.error) console.error(result.error);
      }
      process.exitCode = result.findings.length ? 1 : result.exitCode ? 2 : 0;
    });
  deps.command("fix")
    .description("Apply the ecosystem package manager's supported vulnerability fixes")
    .option("--cwd <path>", "Project directory", process.cwd())
    .option("--ecosystem <name>", "Override detected ecosystem: npm, pnpm, cargo, pypi")
    .option("--yes", "Apply changes; without this flag print the command only")
    .action(async (opts: { cwd: string; ecosystem?: Ecosystem; yes?: boolean }) => {
      const kind = opts.ecosystem ?? await detect(opts.cwd);
      const command = kind === "pnpm" ? "pnpm audit --fix" : kind === "npm" ? "npm audit fix" : kind === "cargo" ? "cargo update" : "pip-audit --fix";
      if (!opts.yes) { console.log(`Dry run. Re-run with --yes to execute: ${command}`); return; }
      const result = await fixDependencies(opts.cwd, opts.ecosystem);
      console.log(result.output || `${result.command} completed`);
      process.exitCode = result.exitCode;
    });
}
