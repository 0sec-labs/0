import type { Command } from "commander";
import chalk from "chalk";
import { getFindingPriority, compareFindingsByBusinessPriority } from "@0/shared";
import type { Finding, FindingTriageStatus, LayerVerdict } from "@0/shared";
import { writePresentationLine, writePresentationErrorLine } from "../presentation/process-output.js";
import {
  listOsecRunDatabasePaths,
  osecDB,
  resolveOsecDbPath,
  resolveOsecRunStorage,
} from "@0/db";
import { buildFindingConsoleCommand } from "../finding-handoff.js";

type FindingsListOptions = {
  dbPath?: string;
  scan?: string;
  severity?: string;
  category?: string;
  status?: string;
  triage?: string;
  limit?: string;
  all?: boolean;
};

type FindingRow = {
  id: string;
  scanId: string;
  title: string;
  severity: string;
  category: string;
  status: string;
  fingerprint?: string | null;
  triageStatus?: string | null;
  triageNote?: string | null;
  timestamp: number;
  score?: number | null;
  cvssScore?: number | null;
  cvssVector?: string | null;
  impactAssessment?: string | null;
  templateId: string;
  description: string;
  evidenceRequest: string;
  evidenceResponse: string;
  evidenceAnalysis?: string | null;
  /**
   * JSON-encoded `LayerVerdict[]` as persisted by the scanner. Nullable and
   * possibly malformed — it is a TEXT column written across engine versions,
   * so `parseLayerVerdicts` treats any parse failure as "no record" rather
   * than throwing in a display path.
   */
  layerVerdicts?: string | null;
};

/**
 * Decode the persisted `layerVerdicts` column into the array shape
 * `summarizeTriageProvenance` expects.
 *
 * Intentionally lenient: this feeds a read-only display, and a finding whose
 * verdict blob is unreadable should still render its evidence. A decode
 * failure yields `[]`, which provenance reports as every layer `unrecorded` —
 * the honest answer, and never a claim that a layer ran.
 */
function parseLayerVerdicts(raw: string | null | undefined): LayerVerdict[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LayerVerdict[]) : [];
  } catch {
    return [];
  }
}

function resolveFindingsOptions(opts: FindingsListOptions, command?: Command): FindingsListOptions {
  const inherited = command?.parent && typeof command.parent.opts === "function"
    ? command.parent.opts() as FindingsListOptions
    : {};
  const local = command && typeof command.opts === "function"
    ? command.opts() as FindingsListOptions
    : {};
  return { ...inherited, ...local, ...opts };
}

/**
 * Resolve the effective `--db-path` for a subcommand action, falling back
 * to the parent `findings` command's parsed option when the subcommand's
 * own slot is empty. Commander binds `--db-path` to the parent when both
 * declare it (see #324), so subcommand actions cannot rely on `opts.dbPath`
 * alone.
 */
function resolveDbPath(
  opts: { dbPath?: string; scan?: string },
  command?: Command,
): string | undefined {
  if (opts.dbPath) return opts.dbPath;
  const parentOpts =
    command?.parent && typeof command.parent.opts === "function"
      ? command.parent.opts() as { dbPath?: string; scan?: string }
      : undefined;
  if (parentOpts?.dbPath) return parentOpts.dbPath;

  const scanId = opts.scan ?? parentOpts?.scan;
  if (!scanId) return undefined;
  return resolveOsecRunStorage({ runId: scanId, resume: true }).dbPath;
}

function withFindingsListOptions(command: Command, options: { defaultLimit?: string } = {}): Command {
  const withFilters = command
    .option("--db-path <path>", "Path to SQLite database")
    .option("--scan <scanId>", "Filter by scan ID")
    .option("--severity <severity>", "Filter by severity: critical, high, medium, low, info")
    .option("--category <category>", "Filter by attack category")
    .option("--status <status>", "Filter by status: discovered, verified, confirmed, scored, reported, fixed, false-positive")
    .option("--triage <triage>", "Filter by triage: new, accepted, suppressed");
  return options.defaultLimit
    ? withFilters.option("--limit <n>", "Max findings/groups to show", options.defaultLimit)
    : withFilters.option("--limit <n>", "Max findings/groups to show");
}

function resolveFindingByPrefix(rows: FindingRow[], id: string): FindingRow | undefined {
  const exact = rows.find((row) => row.id === id);
  if (exact) return exact;
  const matches = rows.filter((row) => row.id.startsWith(id));
  if (matches.length > 1) {
    throw new Error(`Finding prefix '${id}' is ambiguous.`);
  }
  return matches[0];
}

function triageColor(status?: string | null) {
  switch (status) {
    case "accepted":
      return chalk.green;
    case "suppressed":
      return chalk.gray;
    default:
      return chalk.cyan;
  }
}

function severityColor(severity: string) {
  return severity === "critical" ? chalk.red.bold
    : severity === "high" ? chalk.redBright
    : severity === "medium" ? chalk.yellow
    : severity === "low" ? chalk.blue
    : chalk.gray;
}

function statusColor(status: string) {
  return status === "reported" ? chalk.green
    : status === "scored" ? chalk.cyan
    : status === "verified" ? chalk.yellow
    : status === "false-positive" ? chalk.strikethrough.gray
    : chalk.white;
}

type PriorityRow = Pick<FindingRow, "id" | "severity" | "cvssScore" | "impactAssessment" | "timestamp">;
function priorityFinding(row: PriorityRow) {
  let impactAssessment: unknown;
  try { impactAssessment = row.impactAssessment ? JSON.parse(row.impactAssessment) : undefined; } catch { /* Legacy malformed JSON remains unassessed. */ }
  return { severity: row.severity, cvssScore: row.cvssScore, impactAssessment };
}
function compareRows(a: PriorityRow, b: PriorityRow): number {
  return compareFindingsByBusinessPriority(priorityFinding(a), priorityFinding(b)) || b.timestamp - a.timestamp || b.id.localeCompare(a.id);
}
function renderPriority(row: FindingRow): void {
  const priority = getFindingPriority(priorityFinding(row));
  console.log(`  ${chalk.white.bold(`Business priority: ${priority.label}`)} ${chalk.white(row.title)}`);
  console.log(`  ${chalk.gray("Business impact rationale:")} ${priority.rationale}`);
  console.log(`  ${chalk.gray("Technical severity:")} ${severityColor(row.severity)(row.severity)}${row.cvssScore != null ? `  CVSS: ${row.cvssScore}` : ""}${row.cvssVector ? `  CVSS vector: ${row.cvssVector}` : ""}  ${statusColor(row.status)(row.status)}  ${triageColor(row.triageStatus)(String(row.triageStatus ?? "new"))}`);
}

async function renderFindingsList(opts: FindingsListOptions): Promise<void> {
  const selectedDbPath = resolveDbPath(opts);
  const dbPaths = selectedDbPath
    ? [selectedDbPath]
    : listOsecRunDatabasePaths();
  const legacyDbPath = resolveOsecDbPath();
  if (!selectedDbPath && !dbPaths.includes(legacyDbPath)) {
    dbPaths.push(legacyDbPath);
  }

  const limit = Number(opts.limit ?? "50");
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 5000) throw new Error("Finding limit must be an integer between 0 and 5000.");
  const filters = { scanId: opts.scan, severity: opts.severity, category: opts.category, status: opts.status, triageStatus: opts.triage };
  const rows: FindingRow[] = [];
  const groups: Array<{ fingerprint: string; latest: FindingRow; count: number; scans: number }> = [];
  if (!opts.all && dbPaths.length > 1) {
    const databases: osecDB[] = [];
    try {
      for (const path of dbPaths) databases.push(new osecDB(path));
      type Metadata = PriorityRow & Pick<FindingRow, "category" | "status" | "triageStatus"> & { familyKey: string };
      const latestFamilies = new Map<string, { latest: Metadata; database: osecDB }>();
      // Merge every lightweight latest-family record before filters or limits.
      // A newer assessment in another DB must replace an old urgent occurrence.
      for (const database of databases) {
        for (const latest of database.iterateLatestFindingMetadata({ scanId: opts.scan })) {
          const current = latestFamilies.get(latest.familyKey);
          if (!current || latest.timestamp > current.latest.timestamp || (latest.timestamp === current.latest.timestamp && latest.id > current.latest.id)) latestFamilies.set(latest.familyKey, { latest: latest as Metadata, database });
        }
      }
      const selected = [...latestFamilies.values()].filter(({ latest }) =>
        (!opts.severity || latest.severity === opts.severity) && (!opts.category || latest.category === opts.category)
        && (!opts.status || latest.status === opts.status) && (!opts.triage || latest.triageStatus === opts.triage))
        .sort((a, b) => compareRows(a.latest, b.latest)).slice(0, limit);
      for (const { latest, database } of selected) {
        const finding = database.getFinding(latest.id) as FindingRow | undefined;
        if (!finding) throw new Error(`Finding '${latest.id}' changed while its priority was being read.`);
        let count = 0; const scanIds = new Set<string>();
        for (const candidate of databases) {
          const family = candidate.getFindingFamilyMetadata(latest.familyKey, { scanId: opts.scan });
          count += family.count;
          for (const scanId of family.scanIds) scanIds.add(scanId);
        }
        groups.push({ fingerprint: latest.familyKey, latest: finding, count, scans: scanIds.size });
      }
    } finally { for (const database of databases) database.close(); }
  } else {
    for (const dbPath of dbPaths) {
      const db = new osecDB(dbPath);
      try {
        if (opts.all) rows.push(...db.listFindingsByBusinessPriority({ ...filters, limit }) as FindingRow[]);
        else for (const family of db.listFindingFamiliesByBusinessPriority({ ...filters, limit })) groups.push({ fingerprint: family.key, latest: family.latest as FindingRow, count: family.count, scans: family.scanCount });
      } finally { db.close(); }
    }
  }
  rows.sort(compareRows);
  groups.sort((a, b) => compareRows(a.latest, b.latest));
  if (!(opts.all ? rows.length : groups.length)) {
    console.log(chalk.gray("No findings found."));
    return;
  }
  console.log("");
  console.log(chalk.red.bold("  \u25C6 0") + chalk.gray(opts.all ? ` findings (${Math.min(rows.length, limit)})` : ` finding groups (${Math.min(groups.length, limit)})`));
  console.log("");
  if (opts.all) {
    for (const f of rows.slice(0, limit)) {
      renderPriority(f);
      console.log(`  ${chalk.gray(f.id.slice(0, 8))}  ${chalk.gray(f.category)}  ${chalk.gray(`scan:${f.scanId.slice(0, 8)}`)}  ${chalk.gray(`fp:${(f.fingerprint ?? f.id).slice(0, 10)}`)}`);
      console.log("");
    }
    return;
  }
  for (const group of groups.slice(0, limit)) {
    const f = group.latest;
    renderPriority(f);
    console.log(`  ${chalk.gray(`fp:${group.fingerprint.slice(0, 10)}`)}  ${chalk.gray(f.category)}  ${chalk.gray(`${group.count} hits / ${group.scans} scans`)}  ${chalk.gray(`latest:${f.scanId.slice(0, 8)}`)}`);
    if (f.triageNote) console.log(`  ${chalk.gray("note:")} ${chalk.dim(f.triageNote)}`);
    console.log("");
  }
}

async function mutateTriage(
  id: string,
  triageStatus: FindingTriageStatus,
  triageNote: string | undefined,
  dbPath?: string,
): Promise<void> {
  const db = new osecDB(dbPath);
  try {
    const rows = db.listFindings({ limit: 5000 }) as FindingRow[];
    const finding = resolveFindingByPrefix(rows, id);
    if (!finding) {
      throw new Error(`Finding '${id}' not found.`);
    }
    db.updateFindingTriage(finding.id, triageStatus, triageNote);
    const related = finding.fingerprint ? db.getRelatedFindings(finding.fingerprint) as FindingRow[] : [finding];
    console.log(
      `${chalk.green("Updated")} ${chalk.white(related.length.toString())} ${chalk.gray("findings in family")} ${chalk.gray(`fp:${(finding.fingerprint ?? finding.id).slice(0, 10)}`)} ${chalk.gray(`→ ${triageStatus}`)}`
    );
  } finally {
    db.close();
  }
}

export function registerFindingsCommand(program: Command): void {
  // `--all` only declared on the parent so `0 findings list --all`
  // and `0 findings --all list` both resolve via the parent's parsed
  // opts (see #325). If both parent and subcommand declared it, Commander
  // would clobber the user's `true` with the subcommand's default `false`.
  const findingsCmd = withFindingsListOptions(
    program
      .command("findings")
      .description("Browse and manage persisted findings"),
    { defaultLimit: "50" },
  )
    .option("--all", "Show raw finding rows instead of grouped fingerprints", false)
    .action(async (opts: FindingsListOptions, command: Command) => {
      const resolved = resolveFindingsOptions(opts, command);
      const limit = Number.parseInt(resolved.limit ?? "50", 10);
      const selectedDbPath = resolveDbPath(resolved);
      const { isBunRuntime, canUseOpenTui } = await import("../tui/runtime.js");
      if (selectedDbPath && isBunRuntime() && canUseOpenTui()) {
        const { showOpenTuiFindings } = await import("../tui/run.js");
        await showOpenTuiFindings({
          dbPath: selectedDbPath,
          scan: resolved.scan,
          severity: resolved.severity,
          category: resolved.category,
          status: resolved.status,
          triage: resolved.triage,
          limit,
          all: resolved.all,
        });
        return;
      }

      await renderFindingsList(resolved);
    });

  withFindingsListOptions(
    findingsCmd
      .command("list")
      .description("List findings from the database")
  ).action(async (opts: FindingsListOptions, command: Command) => {
    const resolved = resolveFindingsOptions(opts, command);
    const limit = Number.parseInt(resolved.limit ?? "50", 10);
    const selectedDbPath = resolveDbPath(resolved);
    const { isBunRuntime, canUseOpenTui } = await import("../tui/runtime.js");
    if (selectedDbPath && isBunRuntime() && canUseOpenTui()) {
      const { showOpenTuiFindings } = await import("../tui/run.js");
      await showOpenTuiFindings({
        dbPath: selectedDbPath,
        scan: resolved.scan,
        severity: resolved.severity,
        category: resolved.category,
        status: resolved.status,
        triage: resolved.triage,
        limit,
        all: resolved.all,
      });
      return;
    }

    await renderFindingsList(resolved);
  });

  findingsCmd
    .command("show")
    .description("Show detailed information about a finding")
    .argument("<id>", "Finding ID (full or prefix)")
    .option("--db-path <path>", "Path to SQLite database")
    .action(async (id: string, opts: { dbPath?: string }, command: Command) => {
      const selectedDbPath = resolveDbPath(opts, command);
      const db = new osecDB(selectedDbPath);

      try {
        const all = db.listFindings({ limit: 5000 }) as FindingRow[];
        const finding = resolveFindingByPrefix(all, id);
        if (!finding) {
          throw new Error(`Finding '${id}' not found.`);
        }

        const related = finding.fingerprint ? db.getRelatedFindings(finding.fingerprint) as FindingRow[] : [finding];

        console.log("");
        console.log(chalk.red.bold("  \u25C6 0") + chalk.gray(" finding detail"));
        console.log("");

        renderPriority(finding);
        console.log(`  ${chalk.gray("Category:")} ${finding.category}`);
        if (finding.score != null) {
          console.log(`  ${chalk.gray("Score:")} ${chalk.cyan(String(finding.score) + "/100")}`);
        }
        console.log("");
        console.log(`  ${chalk.gray("ID:")}         ${finding.id}`);
        console.log(`  ${chalk.gray("Scan:")}       ${finding.scanId}`);
        console.log(`  ${chalk.gray("Template:")}   ${finding.templateId}`);
        console.log(`  ${chalk.gray("Fingerprint:")} ${(finding.fingerprint ?? finding.id)}`);
        console.log(`  ${chalk.gray("Family size:")} ${related.length}`);
        console.log(`  ${chalk.gray("Time:")}       ${new Date(finding.timestamp).toISOString()}`);
        if (finding.triageNote) {
          console.log(`  ${chalk.gray("Triage:")}     ${finding.triageNote}`);
        }
        console.log("");
        console.log(`  ${chalk.gray("Description:")}`);
        console.log(`  ${finding.description}`);
        console.log("");
        console.log(`  ${chalk.gray("Evidence \u2014 Request:")}`);
        console.log(`  ${chalk.dim(finding.evidenceRequest)}`);
        console.log("");
        console.log(`  ${chalk.gray("Evidence \u2014 Response:")}`);
        console.log(`  ${chalk.dim(finding.evidenceResponse)}`);
        if (finding.evidenceAnalysis) {
          console.log("");
          console.log(`  ${chalk.gray("Evidence \u2014 Analysis:")}`);
          console.log(`  ${chalk.dim(finding.evidenceAnalysis)}`);
        }
        // ── Triage provenance ──
        // The answer to "which FP-moat layers actually ran for this finding?".
        // Rendered for EVERY finding, including ones where nothing ran: an
        // absent section would read as "not applicable" when the truthful
        // reading is "the moat did not run". Derived purely from the recorded
        // verdicts, so it reflects the scan's configuration and not this
        // shell's env — see `triage/provenance.ts`.
        {
          const { summarizeTriageProvenance, formatTriageProvenance } = await import(
            "@0/core"
          );
          const provenance = summarizeTriageProvenance({
            ...(finding as unknown as Finding),
            layerVerdicts: parseLayerVerdicts(finding.layerVerdicts),
          });
          const [headline, totals, ...layerLines] = formatTriageProvenance(provenance);
          console.log("");
          console.log(`  ${chalk.gray("Triage provenance:")}`);
          console.log(
            `  ${provenance.moatEngaged ? chalk.green(headline) : chalk.yellow(headline)}`,
          );
          console.log(`  ${chalk.gray(totals)}`);
          for (const line of layerLines) {
            console.log(`  ${chalk.dim(line)}`);
          }
        }

        if (related.length > 1) {
          console.log("");
          console.log(`  ${chalk.gray("Related Findings:")}`);
          for (const row of related.slice(0, 20)) {
            console.log(`  ${chalk.gray(row.id.slice(0, 8))} ${chalk.gray(`scan:${row.scanId.slice(0, 8)}`)} ${chalk.white(row.status)} ${triageColor(row.triageStatus)(String(row.triageStatus ?? "new"))}`);
          }
        }
        console.log(`  ${chalk.gray("Continue in chat:")}`);
        console.log(`  ${chalk.cyan(buildFindingConsoleCommand(finding, selectedDbPath))}`);
        console.log("");
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      } finally {
        db.close();
      }
    });

  findingsCmd
    .command("accept")
    .description("Mark a finding family as accepted")
    .argument("<id>", "Finding ID (full or prefix)")
    .option("--db-path <path>", "Path to SQLite database")
    .option("--note <text>", "Optional triage note")
    .action(async (id: string, opts: { dbPath?: string; note?: string }, command: Command) => {
      await mutateTriage(id, "accepted", opts.note, resolveDbPath(opts, command));
    });

  findingsCmd
    .command("suppress")
    .description("Suppress a finding family across duplicate occurrences")
    .argument("<id>", "Finding ID (full or prefix)")
    .option("--db-path <path>", "Path to SQLite database")
    .option("--note <text>", "Suppression reason")
    .action(async (id: string, opts: { dbPath?: string; note?: string }, command: Command) => {
      await mutateTriage(id, "suppressed", opts.note, resolveDbPath(opts, command));
    });

  findingsCmd
    .command("reopen")
    .description("Reset a finding family back to new")
    .argument("<id>", "Finding ID (full or prefix)")
    .option("--db-path <path>", "Path to SQLite database")
    .option("--note <text>", "Optional triage note")
    .action(async (id: string, opts: { dbPath?: string; note?: string }, command: Command) => {
      await mutateTriage(id, "new", opts.note, resolveDbPath(opts, command));
    });
}
