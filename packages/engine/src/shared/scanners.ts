/**
 * Scanners the pre-pass can run. A scanner is a command that prints a SARIF 2.1.0 log for a folder; its hits become leads
 * for the scan thread. Nothing else is assumed, so another scanner is one entry here (or, later, one extension).
 */
export interface ScannerSpec {
  id: string;
  label: string;
  /** Executable name looked up on PATH (and, for FoxGuard, next to `0`). */
  command: string;
  /** Arguments; `{folder}` is replaced by the folder. Must write SARIF to standard output. */
  args: string[];
  /** Environment variable that names the binary explicitly. */
  pathEnv?: string;
  /** What running it touches beyond the folder, shown to the user. */
  note?: string;
}

export const SCANNERS: readonly ScannerSpec[] = [
  { id: "foxguard", label: "FoxGuard", command: "foxguard", args: ["--format", "sarif", "{folder}"], pathEnv: "ZERO_FOXGUARD_PATH" },
  { id: "semgrep", label: "Semgrep", command: "semgrep", args: ["scan", "--sarif", "--quiet", "--metrics", "off", "--config", "{rules}", "{folder}"], pathEnv: "ZERO_SEMGREP_PATH", note: "downloads rules for --config when it is a registry pack" },
  { id: "opengrep", label: "OpenGrep", command: "opengrep", args: ["scan", "--sarif", "--quiet", "--config", "{rules}", "{folder}"], pathEnv: "ZERO_OPENGREP_PATH" },
];
export const DEFAULT_SCANNERS: readonly string[] = ["foxguard"];
const DEFAULT_RULES = "p/default";

export function scannerById(id: string): ScannerSpec | undefined { return SCANNERS.find(scanner => scanner.id === id); }

/** The scanner ids in `--scanner`, validated. Throws a message naming the valid ids. */
export function parseScannerList(values: readonly string[] | undefined): string[] {
  if (!values?.length) return [...DEFAULT_SCANNERS];
  const ids = values.flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean);
  const unknown = ids.filter(id => !scannerById(id));
  if (unknown.length) throw new Error(`Unknown scanner ${unknown.map(id => `'${id}'`).join(", ")}; choose from ${SCANNERS.map(scanner => scanner.id).join(", ")}.`);
  return [...new Set(ids)];
}

export function scannerArguments(spec: ScannerSpec, folder: string, rules = DEFAULT_RULES): string[] {
  return spec.args.map(arg => arg === "{folder}" ? folder : arg === "{rules}" ? rules : arg);
}
