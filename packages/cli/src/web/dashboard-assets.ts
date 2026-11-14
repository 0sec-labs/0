// Resolution and materialization of the built dashboard frontend assets.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { tmpdir } from "node:os";
import { DASHBOARD_ASSETS, type EmbeddedDashboardAsset } from "../dashboard-assets.generated.js";

type DashboardAssetDirectory = {
  path: string;
  cleanup?: () => void;
};

function materializeEmbeddedDashboardAssets(
  assets: readonly EmbeddedDashboardAsset[],
): DashboardAssetDirectory | null {
  if (assets.length === 0) return null;

  const assetDir = mkdtempSync(join(tmpdir(), "0-dashboard-"));
  try {
    for (const [relativePath, contentBase64] of assets) {
      const candidate = resolve(assetDir, `.${relativePath.replaceAll("\\", "/")}`);
      if (candidate === assetDir || !candidate.startsWith(`${assetDir}${sep}`)) {
        throw new Error(`Invalid embedded dashboard asset path: ${JSON.stringify(relativePath)}`);
      }
      mkdirSync(dirname(candidate), { recursive: true, mode: 0o700 });
      writeFileSync(candidate, Buffer.from(contentBase64, "base64"), { mode: 0o600 });
    }
    if (!existsSync(join(assetDir, "index.html"))) {
      throw new Error("Embedded dashboard assets do not contain index.html.");
    }
  } catch (error) {
    rmSync(assetDir, { recursive: true, force: true });
    throw error;
  }

  return {
    path: assetDir,
    cleanup: () => rmSync(assetDir, { recursive: true, force: true }),
  };
}

export function resolveDashboardAssetDir(moduleUrl: string, explicitAssetDir?: string): DashboardAssetDirectory {
  const moduleDir = resolve(fileURLToPath(new URL(".", moduleUrl)));
  const candidates = [
    ...(explicitAssetDir ? [resolve(explicitAssetDir)] : []),
    join(moduleDir, "dashboard"),
    join(moduleDir, "..", "dashboard"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return { path: candidate };
    }
  }

  const embedded = materializeEmbeddedDashboardAssets(DASHBOARD_ASSETS);
  if (embedded) return embedded;

  // The checked-in embedded-assets stub is empty in source and Node builds,
  // so development falls back to the workspace dashboard. Standalone binaries
  // must use their embedded release assets even when launched inside a checkout
  // that happens to contain an older packages/web/dist build.
  const checkoutPackage = resolve(moduleDir, "..", "..");
  for (const candidate of [
    // A source-built CLI can run from a different project directory. Resolve
    // its sibling app from the checkout, never from an unrelated installed CLI.
    ...(existsSync(join(checkoutPackage, "src", "index.ts"))
      ? [join(checkoutPackage, "..", "web", "dist")]
      : []),
    join(process.cwd(), "packages", "web", "dist"),
    join(process.cwd(), "dist", "dashboard"),
  ]) {
    if (existsSync(join(candidate, "index.html"))) {
      return { path: candidate };
    }
  }
  throw new Error("Dashboard assets not found. Run `pnpm build` to generate the dashboard app.");
}

export function resolveAssetPath(assetDir: string, pathname: string): string | null {
  const trimmed = pathname === "/" ? "/index.html" : pathname;
  const assetRoot = resolve(assetDir);
  const candidate = resolve(assetRoot, `.${trimmed}`);
  if (candidate !== assetRoot && !candidate.startsWith(`${assetRoot}${sep}`)) return null;
  try { if (!statSync(candidate).isFile()) return null; } catch { return null; }
  return candidate;
}
