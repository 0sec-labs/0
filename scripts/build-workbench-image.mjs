#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { statfsSync, createWriteStream, statSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { manifest, resolveWorkbenchProfile, immutableImageReference } from "./workbench-profile.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const GiB = 1024 ** 3;
export function planWorkbenchBuild({ profile = "core-web", kaliImage, sourceRevision, archive, availableBytes }) {
  const selected = resolveWorkbenchProfile(profile);
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "")) throw new Error("Build requires an exact source commit");
  if (profile === "kali" && !immutableImageReference(kaliImage)) throw new Error("Kali requires an immutable pre-provisioned image reference with @sha256");
  if (kaliImage && profile !== "kali") throw new Error("--kali-image is only valid for the Kali profile");
  if (!archive || !archive.startsWith("/")) throw new Error("Build export requires an absolute archive path");
  const baseImage = profile === "kali" ? kaliImage : manifest.baseImage;
  const tag = `0-workbench:${profile}-${sourceRevision.slice(0, 12)}`;
  const args = ["build", "--platform", manifest.platform, "--file", "Dockerfile.workbench", "--target", "workbench",
    "--build-arg", `TOOLBOX_PROFILE=${profile}`, "--build-arg", `SOURCE_REVISION=${sourceRevision}`,
    "--build-arg", `BASE_IMAGE=${baseImage}`, "--tag", tag];
  if (profile === "kali") args.push("--build-arg", "WORKBENCH_BASE=kali-base", "--build-arg", `KALI_IMAGE=${kaliImage}`);
  args.push(".");
  return { schemaVersion: 1, profile, platform: manifest.platform, sourceRevision, baseImage,
    aptSnapshot: profile === "kali" ? null : manifest.aptSnapshot, archive, tag,
    minimumBuildFreeGiB: selected.minimumBuildFreeGiB, availableGiB: Math.floor(availableBytes / GiB),
    diskReady: availableBytes >= selected.minimumBuildFreeGiB * GiB, maximumArchiveBytes: selected.maximumArchiveGiB * GiB,
    inventoryPath: manifest.inventoryPath, commands: [{ command: "docker", args }, { command: "docker", args: ["image", "save", tag] }],
    qualification: "not-built", recommendedGuest: selected.recommendedGuest };
}

export function assertWorkbenchBuildReady(plan, { dirty, archiveExists }) {
  if (!plan.diskReady) throw new Error(`Build requires ${plan.minimumBuildFreeGiB} GiB free; ${plan.availableGiB} GiB available. No image build started.`);
  if (dirty) throw new Error("Commit source changes before building an identified image");
  if (archiveExists) throw new Error("Archive already exists; choose a new output path");
}

async function main() {
  const values = { profile: "core-web" }; let build = false;
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === "--build") { build = true; continue; }
    const keys = { "--profile": "profile", "--kali-image": "kaliImage", "--archive": "archive" };
    if (!Object.hasOwn(keys, flag) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw new Error(`Unknown or incomplete argument: ${flag}`);
    values[keys[flag]] = process.argv[++i];
  }
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (git.status !== 0) throw new Error("Cannot identify source commit");
  values.sourceRevision = git.stdout.trim();
  values.archive ??= resolve(root, `workbench-${values.profile}.tar`);
  const storage = statfsSync(dirname(values.archive));
  values.availableBytes = Number(storage.bavail) * Number(storage.bsize);
  const plan = planWorkbenchBuild(values);
  console.log(JSON.stringify(plan, null, 2));
  if (!build) return;
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (status.status !== 0) throw new Error("Cannot inspect source working tree");
  assertWorkbenchBuildReady(plan, { dirty: Boolean(status.stdout.trim()), archiveExists: existsSync(plan.archive) });
  const buildResult = spawnSync("docker", plan.commands[0].args, { cwd: root, stdio: "inherit", timeout: 45 * 60_000 });
  if (buildResult.error || buildResult.status !== 0) throw new Error(`Image build failed (${buildResult.status})`);
  const inspect = spawnSync("docker", ["image", "inspect", plan.tag, "--format", "{{.Os}}/{{.Architecture}}"], { encoding: "utf8", timeout: 10_000 });
  if (inspect.status !== 0 || inspect.stdout.trim() !== plan.platform) throw new Error("Built image platform differs from selected ARM64 profile");
  const temporary = `${plan.archive}.${randomBytes(8).toString("hex")}.partial`;
  const child = spawn("docker", plan.commands[1].args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  let bytes = 0; const hash = createHash("sha256");
  const bounded = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > plan.maximumArchiveBytes) return callback(new Error("Export exceeds profile archive cap"));
    hash.update(chunk); callback(null, chunk);
  } });
  const exited = new Promise((done, fail) => { child.once("error", fail); child.once("close", code => code === 0 ? done() : fail(new Error(`Archive export failed (${code})`))); });
  // Keep an early child failure observed while the stream settles.
  exited.catch(() => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
  try {
    await pipeline(child.stdout, bounded, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await exited;
    if (!bytes || statSync(temporary).size !== bytes) throw new Error("Incomplete archive export");
    if (existsSync(plan.archive)) throw new Error("Archive destination appeared during export");
    // Link rather than overwrite: exports never replace an existing user's archive.
    const { linkSync } = await import("node:fs"); linkSync(temporary, plan.archive); rmSync(temporary);
    console.log(JSON.stringify({ archive: plan.archive, archiveDigest: `sha256:${hash.digest("hex")}`, archiveBytes: bytes, qualification: "image-build-receipt-only; guest smoke still required" }));
  } finally { clearTimeout(timer); child.kill("SIGKILL"); rmSync(temporary, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
