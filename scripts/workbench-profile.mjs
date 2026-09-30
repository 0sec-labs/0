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
