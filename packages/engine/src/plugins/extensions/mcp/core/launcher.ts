/**
 * Pure: package launchers (`npx`, `uvx`, `pip`...) fetch code from a registry at launch. Detect them, find the package,
 * and say whether the arguments pin an exact version. An unpinned package is refused: what runs would be whatever the
 * registry serves that day.
 */
export interface LauncherInfo {
  readonly launcher: string;
  readonly ecosystem: "npm" | "pypi";
  /** The package spec as written, or null when no package argument could be found. */
  readonly spec: string | null;
  readonly pinned: boolean;
  /** Registry hosts the launcher talks to, so `beforeCommand` can see them. */
  readonly hosts: readonly string[];
}

const NPM_HOSTS = ["registry.npmjs.org"];
const PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PEP440 = /^\d+(?:\.\d+)*(?:(?:a|b|rc|post|dev)\d+)*$/;
const COMMIT = /^[0-9a-f]{40}$/;

const base = (command: string): string => command.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(cmd|exe)$/, "");

/** npm style `name@1.2.3`, `@scope/name@1.2.3`, or a git spec pinned to a full commit. */
export function npmSpecPinned(spec: string): boolean {
  if (/^(?:git\+|github:|git:|https?:)/.test(spec) || /^[\w.-]+\/[\w.-]+#/.test(spec)) return COMMIT.test(spec.split("#")[1] ?? "");
  const at = spec.lastIndexOf("@");
  return at > 0 && SEMVER.test(spec.slice(at + 1));
}
/** PyPI style `name==1.2.3`, or `name@1.2.3` (uvx), or a git spec pinned to a full commit. */
export function pypiSpecPinned(spec: string): boolean {
  if (/^git\+/.test(spec)) return COMMIT.test(spec.split("@").pop() ?? "");
  const eq = spec.match(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?==(.+)$/); if (eq) return PEP440.test(eq[1]!);
  const at = spec.lastIndexOf("@"); return at > 0 && PEP440.test(spec.slice(at + 1));
}

/** First argument that is the package: skip flags (and the value of those that take one). */
function firstPackage(args: readonly string[], valueFlags: readonly string[], fromFlags: readonly string[] = []): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (fromFlags.includes(a)) return args[i + 1] ?? null;
    const eq = fromFlags.find(f => a.startsWith(`${f}=`)); if (eq) return a.slice(eq.length + 1);
    if (valueFlags.includes(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

export function inspectLauncher(command: string, args: readonly string[]): LauncherInfo | null {
  const name = base(command); const rest = [...args];
  const npm = (launcher: string, a: readonly string[], valueFlags: readonly string[] = ["--registry", "--cache", "-c", "--call", "--userconfig"]): LauncherInfo => {
    const spec = firstPackage(a, valueFlags, ["-p", "--package"]); return { launcher, ecosystem: "npm", spec, pinned: spec !== null && npmSpecPinned(spec), hosts: NPM_HOSTS };
  };
  const pypi = (launcher: string, a: readonly string[], fromFlags: readonly string[] = ["--from"]): LauncherInfo => {
    const spec = firstPackage(a, ["--index-url", "-i", "--python", "-p", "--with", "--index", "--extra-index-url"], fromFlags);
    return { launcher, ecosystem: "pypi", spec, pinned: spec !== null && pypiSpecPinned(spec), hosts: PYPI_HOSTS };
  };
  if (name === "npx" || name === "bunx" || name === "pnpx") return npm(name, rest);
  if ((name === "pnpm" || name === "yarn") && rest[0] === "dlx") return npm(`${name} dlx`, rest.slice(1));
  if (name === "npm" && (rest[0] === "exec" || rest[0] === "x")) return npm("npm exec", rest.slice(1));
  if (name === "bun" && rest[0] === "x") return npm("bun x", rest.slice(1));
  if (name === "uvx") return pypi("uvx", rest);
  if (name === "uv" && rest[0] === "tool" && rest[1] === "run") return pypi("uv tool run", rest.slice(2));
  if (name === "pipx" && rest[0] === "run") return pypi("pipx run", rest.slice(1), ["--spec"]);
  if ((name === "pip" || name === "pip3") && rest[0] === "install") return pypi(name, rest.slice(1), []);
  return null;
}

/** The refusal text for the operator and the model, or null when the launch is fine. */
export function unpinnedRefusal(info: LauncherInfo | null): string | null {
  if (!info || info.pinned) return null;
  const where = info.ecosystem === "npm" ? "an exact version, such as name@1.2.3 (or a git commit)" : "an exact version, such as name==1.2.3 (or a git commit)";
  return info.spec === null
    ? `${info.launcher} would fetch a package from ${info.hosts[0]} at launch and no package argument was found: pin ${where} in the extension's arguments`
    : `${info.launcher} would fetch ${JSON.stringify(info.spec.slice(0, 80))} from ${info.hosts[0]} at launch without a pinned version: pin ${where} in the extension's arguments`;
}
