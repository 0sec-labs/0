import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { SMOLVM_DARWIN_SUPERVISOR_SOURCE } from "./smolvm-darwin-source.js";

const VERSION = "1.14.6";
const BUNDLE_NAME = `smolvm-${VERSION}-darwin-arm64`;
const BUNDLE_DIGEST = "484b63c6a7c74c4d05dce2e63fcce3d135e0fba56a1d77128024e5736d3384a8";
const BUNDLE_BYTES = 37557621;
const URL = `https://github.com/smol-machines/smolvm/releases/download/v${VERSION}/${BUNDLE_NAME}.tar.gz`;
export interface SmolvmRuntimeOptions { stateRoot?: string; signal?: AbortSignal; }
export interface SmolvmRuntime { version: string; binary: string; bundleRoot: string; supervisor: string; }
export interface SmolvmWorkbenchImageOptions { imageArchive: string; stateRoot: string; signal?: AbortSignal; }
export interface SmolvmWorkbenchImage { path: string; digest: string; }
export interface SmolvmWorkbenchStatusOptions { stateRoot: string; image?: string; }
export interface SmolvmWorkbenchStatus {
  platformSupported: boolean; runtimeReady: boolean; imageApproved: boolean; retainedRuns: readonly string[]; error?: string;
}

export function assertSmolvmWorkbenchPlatform(): void {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() === 0) {
    throw new Error("SmolVM workbench requires a non-root Apple Silicon macOS host; no host or Docker fallback is permitted");
  }
}
export async function privateSmolvmDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || /[:\0]/.test(path)) throw new Error("SmolVM state requires an absolute path without colon or NUL");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error(`SmolVM state must be a private operator-owned directory: ${path}`);
  }
}
export function smolvmExec(binary: string, argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  execFile(binary, argv, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, ...options, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${binary} failed: ${stderr.trim() || error.message}`));
    else resolve({ stdout, stderr });
  });
  return promise;
}
export async function smolvmArchiveDigest(path: string, signal?: AbortSignal): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 8 * 1024 ** 3) throw new Error("SmolVM image must be a regular nonempty archive no larger than 8 GiB");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk);
    return `sha256:${hash.digest("hex")}`;
  } finally { await file.close(); }
}
function runtimePaths(root: string): SmolvmRuntime {
  const bundleRoot = join(root, "runtime", BUNDLE_NAME);
  const sourceDigest = createHash("sha256").update(SMOLVM_DARWIN_SUPERVISOR_SOURCE).digest("hex").slice(0, 16);
  return { version: VERSION, binary: join(bundleRoot, "smolvm"), bundleRoot, supervisor: join(root, "runtime", `supervisor-${sourceDigest}`) };
}
async function verifyBundle(runtime: SmolvmRuntime, signal?: AbortSignal): Promise<void> {
  const binary = join(runtime.bundleRoot, "smolvm-bin");
  await smolvmExec("/usr/bin/codesign", ["--verify", "--strict", "--deep", binary], { signal });
  const entitlement = await smolvmExec("/usr/bin/codesign", ["-d", "--entitlements", ":-", binary], { signal });
  if (!/<key>com\.apple\.security\.hypervisor<\/key>\s*<true\s*\/>/.test(entitlement.stdout + entitlement.stderr)) {
    throw new Error("Upstream SmolVM runtime lacks the required Hypervisor entitlement; it will not be re-signed");
  }
  for (const entry of ["lib/libkrun.dylib", "lib/libkrunfw.5.dylib", "agent-rootfs/usr/local/bin/smolvm-agent"]) await stat(join(runtime.bundleRoot, entry));
  const version = await smolvmExec(runtime.binary, ["--version"], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, signal });
  if (version.stdout.trim() !== `smolvm ${VERSION}`) throw new Error("Pinned SmolVM version mismatch");
}
/** Explicit setup only. Preserve the full signed distribution, including rootfs,
 * dylibs and sparse-disk templates; do not change PATH, shell files or signatures. */
export async function resolveSmolvmRuntime(options: SmolvmRuntimeOptions = {}): Promise<SmolvmRuntime> {
  assertSmolvmWorkbenchPlatform();
  options.signal?.throwIfAborted();
  const root = options.stateRoot ?? join(homedir(), ".0", "workbench");
  await privateSmolvmDirectory(root);
  await privateSmolvmDirectory(join(root, "runtime"));
  const runtime = runtimePaths(root);
  try { await stat(runtime.binary); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const staging = join(root, "runtime", `.provision-${randomBytes(8).toString("hex")}`);
    await privateSmolvmDirectory(staging);
    try {
      const response = await fetch(URL, { signal: options.signal });
      if (!response.ok || !response.body) throw new Error(`Pinned SmolVM download failed (HTTP ${response.status})`);
      const archive = join(staging, "bundle.tar.gz");
      let bytes = 0;
      const hash = createHash("sha256");
      const source = Readable.fromWeb(response.body as ReadableStream);
      source.on("data", (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); if (bytes > BUNDLE_BYTES) source.destroy(new Error("SmolVM release exceeds pinned byte count")); });
      await pipeline(source, createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal: options.signal });
      if (bytes !== BUNDLE_BYTES || hash.digest("hex") !== BUNDLE_DIGEST) throw new Error("Pinned SmolVM release checksum or byte count mismatch");
      // Only checksum-approved upstream bytes reach the extractor. The guest
      // rootfs intentionally contains absolute symlinks; preserve those links.
      await smolvmExec("/usr/bin/tar", ["-xzf", archive, "-C", staging], { signal: options.signal });
      const staged = { ...runtime, binary: join(staging, BUNDLE_NAME, "smolvm"), bundleRoot: join(staging, BUNDLE_NAME) };
      await verifyBundle(staged, options.signal);
      await rename(staged.bundleRoot, runtime.bundleRoot);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  await verifyBundle(runtime, options.signal);
  try { await stat(runtime.supervisor); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const source = `${runtime.supervisor}.${randomBytes(8).toString("hex")}.c`;
    const output = `${source}.bin`;
    try {
      await writeFile(source, SMOLVM_DARWIN_SUPERVISOR_SOURCE, { flag: "wx", mode: 0o600 });
      await smolvmExec("/usr/bin/xcrun", ["clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output], { signal: options.signal });
      await chmod(output, 0o700);
      await rename(output, runtime.supervisor);
    } finally { await rm(source, { force: true }); await rm(output, { force: true }); }
  }
  await writeFile(join(root, "runtime", "ready.json"), JSON.stringify({ ...runtime, bundleDigest: BUNDLE_DIGEST }), { mode: 0o600 });
  return runtime;
}
/** An operator setup boundary, never a tool/model-controlled image selection. */
export async function approveSmolvmWorkbenchImage(options: SmolvmWorkbenchImageOptions): Promise<SmolvmWorkbenchImage> {
  assertSmolvmWorkbenchPlatform();
  if (!isAbsolute(options.imageArchive)) throw new Error("Workbench setup requires an absolute local image archive");
  await privateSmolvmDirectory(options.stateRoot);
  const images = join(options.stateRoot, "images");
  await privateSmolvmDirectory(images);
  const digest = await smolvmArchiveDigest(options.imageArchive, options.signal);
  const destination = join(images, `${digest.slice(7)}.tar`);
  if (options.imageArchive !== destination) {
    const staging = join(images, `.approve-${randomBytes(8).toString("hex")}.tar`);
    try {
      // APFS clone avoids duplicating a multi-GiB toolbox; other supported
      // filesystems use the same copy semantics, without linking mutable bytes.
      await copyFile(options.imageArchive, staging, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await chmod(staging, 0o600);
      if (await smolvmArchiveDigest(staging, options.signal) !== digest) throw new Error("Image changed during approval");
      await rename(staging, destination);
    } finally { await rm(staging, { force: true }); }
  }
  const image = { path: destination, digest };
  await writeFile(`${destination}.json`, JSON.stringify({ schemaVersion: 1, ...image }), { flag: "w", mode: 0o600 });
  return image;
}
export async function approvedSmolvmWorkbenchImage(image: string, stateRoot: string, signal?: AbortSignal): Promise<SmolvmWorkbenchImage> {
  const filename = image.split("/").at(-1) ?? "";
  if (!/^[a-f0-9]{64}\.tar$/.test(filename) || image !== join(stateRoot, "images", filename)) throw new Error("Workbench image must be a local immutable archive approved during setup");
  const approval = JSON.parse(await readFile(`${image}.json`, "utf8")) as { schemaVersion?: number; path?: string; digest?: string };
  const expected = `sha256:${filename.slice(0, 64)}`;
  if (approval.schemaVersion !== 1 || approval.path !== image || approval.digest !== expected) throw new Error("Workbench image approval mismatch");
  if (await smolvmArchiveDigest(image, signal) !== expected) throw new Error("Approved workbench image bytes changed");
  return { path: image, digest: expected };
}
export async function getSmolvmWorkbenchStatus(options: SmolvmWorkbenchStatusOptions): Promise<SmolvmWorkbenchStatus> {
  const result: SmolvmWorkbenchStatus = { platformSupported: process.platform === "darwin" && process.arch === "arm64" && process.getuid?.() !== 0, runtimeReady: false, imageApproved: false, retainedRuns: [] };
  try {
    const runtime = runtimePaths(options.stateRoot);
    const ready = JSON.parse(await readFile(join(options.stateRoot, "runtime", "ready.json"), "utf8")) as SmolvmRuntime;
    result.runtimeReady = ready.binary === runtime.binary && ready.supervisor === runtime.supervisor && (await stat(runtime.binary)).isFile() && (await stat(runtime.supervisor)).isFile();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.error = String(error); }
  if (options.image) {
    try {
      const approval = JSON.parse(await readFile(`${options.image}.json`, "utf8")) as SmolvmWorkbenchImage;
      result.imageApproved = approval.path === options.image && /^sha256:[a-f0-9]{64}$/.test(approval.digest) && dirname(approval.path) === join(options.stateRoot, "images") && (await lstat(approval.path)).isFile();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.error = String(error); }
  }
  try { const lease = JSON.parse(await readFile(join(options.stateRoot, "active-run.json"), "utf8")) as { root?: string }; result.retainedRuns = [lease.root ?? "unknown retained workbench run"]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.error = String(error); }
  return result;
}
