import { readFileSync } from "node:fs";

export const manifest = JSON.parse(readFileSync(new URL("./workbench-profiles.json", import.meta.url), "utf8"));
export function resolveWorkbenchProfile(name) {
  if (!Object.hasOwn(manifest.profiles, name)) throw new Error(`Unknown workbench profile: ${name}`);
  const selected = manifest.profiles[name];
  const inherited = selected.extends ? resolveWorkbenchProfile(selected.extends) : { packages: [], probes: [], pythonModules: [] };
  const packages = [...new Set([...inherited.packages, ...selected.packages])];
  if (packages.some(value => !/^[a-z0-9][a-z0-9+.-]*$/.test(value))) throw new Error("Invalid OS package name");
  return { ...selected, name, packages, probes: [...inherited.probes, ...selected.probes], pythonModules: [...new Set([...inherited.pythonModules, ...selected.pythonModules])] };
}
export function immutableImageReference(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value);
}

/** Accepted help exit codes must not turn initialization failures into receipts. */
export function assertWorkbenchToolProbe(name, result, expected = [0]) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const diagnostic = /permission denied|\bEACCES\b|Traceback \(most recent call last\)|Critical failure/i.test(output);
  if (result.error || !expected.includes(result.status) || !output || diagnostic) {
    const reason = result.error?.code ?? (diagnostic ? "startup diagnostic" : !output ? "no version output" : "unexpected exit");
    throw new Error(`Required tool startup failed: ${name} (exit ${result.status}, ${reason})`);
  }
  return { exitCode: result.status, versionOutput: output.slice(0, 4096) };
}

/** Older Gobuster releases use a version subcommand; newer ones use a flag. */
export function workbenchProbeFallback(name, args, result) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return name === "gobuster" && args.length === 1 && args[0] === "version"
    && !result.error && result.status !== 0 && /No help topic for ['"]version['"]/.test(output)
    ? ["--version"] : null;
}
