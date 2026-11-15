#!/usr/bin/env node
// Guard: how installed copies of 0 learn about and apply updates must not drift
// from what release.yml publishes. Old binaries in the field depend on these
// URLs and asset names, so a rename here silently strands them.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CANONICAL = "0sec-labs/0security";
const LEGACY = "0sec-labs/0";

export function checkUpdateContract(root) {
  const read = (p) => readFileSync(join(root, p), "utf8");
  const errors = [];
  const release = read(".github/workflows/release.yml");
  const installer = read("install.sh");
  const updater = read("packages/cli/src/utils/update-check.ts");
  const redirects = read("docs/public/_redirects");

  const assets = [...release.matchAll(/^\s*asset:\s*(\S+)/gm)].map((m) => m[1]);
  if (assets.length < 4) errors.push(`release.yml lists ${assets.length} binary assets, expected 4`);
  const checksums = /sha256sum ([^>\n]+)> checksums\.txt/.exec(release)?.[1].trim().split(/\s+/) ?? [];
  for (const a of assets) {
    if (!checksums.includes(a)) errors.push(`release.yml builds ${a} but checksums.txt does not cover it`);
  }
  // install.sh handles every non-Windows asset by exact name.
  for (const a of assets.filter((x) => !x.endsWith(".exe"))) {
    if (!installer.includes(`ASSET="${a}"`)) errors.push(`install.sh has no mapping to release asset ${a}`);
  }
  for (const m of installer.matchAll(/(?<!\w)ASSET="([^"]+)"/g)) {
    if (!assets.includes(m[1])) errors.push(`install.sh downloads ${m[1]}, which release.yml does not publish`);
  }
  if (!installer.includes(`REPO="${CANONICAL}"`)) errors.push(`install.sh REPO must be ${CANONICAL}`);
  if (!installer.includes("${REPO}/releases/latest/download")) errors.push("install.sh must default to the releases/latest/download URL");
  if (!installer.includes("checksums.txt")) errors.push("install.sh must verify against checksums.txt");

  if (!updater.includes(`const REPO = "${CANONICAL}"`)) errors.push(`update-check.ts REPO must be ${CANONICAL}`);
  if (!updater.includes(`const LEGACY_REPO = "${LEGACY}"`)) errors.push(`update-check.ts must keep the ${LEGACY} fallback slug`);
  if (!/const REPO_ID = \d+/.test(updater)) errors.push("update-check.ts must keep the numeric repository id fallback");
  if (!updater.includes("/releases/download/${normalizedTag}")) errors.push("update-check.ts must pin RELEASE_BASE_URL to /releases/download/<tag>");
  if (!updater.includes("raw.githubusercontent.com/${slug}/main/install.sh")) errors.push("update-check.ts must fetch install.sh from raw.githubusercontent.com");
  if (/https:\/\/github\.com\/0sec-labs\/0(?![\w-])/.test(updater.replace(/LEGACY_REPO = "[^"]+"/, ""))) {
    errors.push("update-check.ts hardcodes the legacy repository slug outside the fallback");
  }
  if (!/^\/install\.sh\s+https:\/\/raw\.githubusercontent\.com\/0sec-labs\/0security\/main\/install\.sh\s+302\s*$/m.test(redirects)) {
    errors.push("docs/public/_redirects must redirect /install.sh to the canonical raw install.sh");
  }
  return errors;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2] ?? join(import.meta.dirname, "..");
  const errors = checkUpdateContract(root);
  if (errors.length) {
    for (const e of errors) console.error(`check-update-contract: ${e}`);
    process.exit(1);
  }
  console.log("check-update-contract: ok");
}
