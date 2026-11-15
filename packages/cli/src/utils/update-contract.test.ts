import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLatestTag, performAutoUpdate, resolveUpdatePolicy } from "./update-check.js";
import { defaultInstallDir, detectInstallKind, isNpmStyleInstall } from "./install-origin.js";
import { UpdateManager } from "../web/update-manager.js";
import { restartCommand } from "../web/self-restart.js";

/** A local stand-in for GitHub: no network. Routes map a path to [status, headers, body]. */
type Route = [number, Record<string, string>, string | Buffer];
let server: Server;
let base: string;
let hits: string[];
let routes: Record<string, Route>;

beforeEach(async () => {
  hits = [];
  routes = {};
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const route = routes[req.url ?? ""] ?? [404, {}, "not found"];
    res.writeHead(route[0], route[1]);
    res.end(route[2]);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

describe("latest release resolution", () => {
  const sources = () => [
    { url: `${base}/api/new`, kind: "api" as const },
    { url: `${base}/web/latest`, kind: "redirect" as const },
    { url: `${base}/api/id`, kind: "api" as const },
  ];
  const json = (body: unknown): Route => [200, { "content-type": "application/json" }, JSON.stringify(body)];

  it("reads the tag from the API", async () => {
    routes["/api/new"] = json({ tag_name: "v1.2.3" });
    expect(await fetchLatestTag(sources(), 2000)).toBe("v1.2.3");
    expect(hits).toEqual(["/api/new"]);
  });

  it("falls back to the web redirect when the API is rate limited (403)", async () => {
    routes["/api/new"] = [403, {}, '{"message":"API rate limit exceeded"}'];
    routes["/web/latest"] = [302, { location: "https://github.com/x/y/releases/tag/v1.4.0" }, ""];
    expect(await fetchLatestTag(sources(), 2000)).toBe("v1.4.0");
  });

  it("falls back to the repository id URL after a rename breaks the slug (404) and the redirect", async () => {
    routes["/api/id"] = json({ tag_name: "v2.0.0" });
    expect(await fetchLatestTag(sources(), 2000)).toBe("v2.0.0");
    expect(hits).toEqual(["/api/new", "/web/latest", "/api/id"]);
  });

  it("ignores prereleases, drafts and malformed tags, and returns null without throwing", async () => {
    routes["/api/new"] = json({ tag_name: "v9.0.0", prerelease: true });
    routes["/web/latest"] = [302, { location: "https://github.com/x/y/releases/tag/v9.0.0-rc.1" }, ""];
    routes["/api/id"] = json({ tag_name: "latest;rm -rf" });
    expect(await fetchLatestTag(sources(), 2000)).toBeNull();
  });

  it("returns null quickly when the server hangs or is unreachable", async () => {
    const started = Date.now();
    expect(await fetchLatestTag([{ url: "http://127.0.0.1:1/none", kind: "api" }], 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("install origin", () => {
  it("recognises npm-style installs without any network", () => {
    expect(isNpmStyleInstall({ argv1: "/usr/local/lib/node_modules/0sec-cli/dist/index.js", execPath: "/usr/bin/node" })).toBe(true);
    expect(isNpmStyleInstall({ argv1: "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\0sec-cli\\index.js", execPath: "C:\\node.exe" })).toBe(true);
    expect(isNpmStyleInstall({ argv1: "/$bunfs/root/0", execPath: "/home/a/.0/bin/0" })).toBe(false);
  });

  it("updates in place next to a writable standalone binary, else uses the installer default", () => {
    const yes = () => true;
    expect(defaultInstallDir({ execPath: "/usr/local/bin/0" }, yes)).toBe("/usr/local/bin");
    expect(defaultInstallDir({ execPath: "/usr/local/bin/0" }, () => false)).toBeUndefined();
    expect(defaultInstallDir({ execPath: "/usr/bin/node", argv1: "/src/index.js" }, yes)).toBeUndefined();
    expect(defaultInstallDir({ execPath: "/x/node_modules/.bin/0" }, yes)).toBeUndefined();
  });
});

const installer = join(import.meta.dirname, "../../../../install.sh");
const asset = process.platform === "darwin" && process.arch === "arm64" ? "0-darwin-arm64"
  : process.platform === "linux" && process.arch === "x64" ? "0-linux-x64"
  : process.platform === "linux" && process.arch === "arm64" ? "0-linux-arm64" : undefined;

describe.skipIf(!asset || !existsSync(installer))("install.sh swap against a fake release server", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "0-install-contract-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Async: the fake release server lives in this process, so a blocking spawn would deadlock it. */
  function install(): Promise<{ status: number; stderr: string }> {
    return new Promise(resolve => execFile("sh", [installer], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, SHELL: "/bin/sh", INSTALL_DIR: join(dir, "bin"),
        RELEASE_BASE_URL: `${base}/releases/download/v9.9.9`, INSTALL_FOXGUARD: "0", TMPDIR: dir },
    }, (error, _stdout, stderr) => resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stderr })));
  }
  function publish(body: string, checksum = createHash("sha256").update(body).digest("hex")) {
    routes["/releases/download/v9.9.9/checksums.txt"] = [200, {}, `${checksum}  ${asset}\n`];
    routes[`/releases/download/v9.9.9/${asset}`] = [200, {}, body];
  }

  it("replaces an existing binary atomically, executable, after verifying the checksum", async () => {
    const target = join(dir, "bin", "0");
    execFileSync("mkdir", ["-p", join(dir, "bin")]);
    writeFileSync(target, "#!/bin/sh\necho old\n");
    chmodSync(target, 0o700);
    publish("#!/bin/sh\necho new\n");
    const result = await install();
    expect(result.status, result.stderr).toBe(0);
    expect(execFileSync(target, { encoding: "utf8" })).toBe("new\n");
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it("refuses a checksum mismatch and leaves the old binary untouched", async () => {
    const target = join(dir, "bin", "0");
    execFileSync("mkdir", ["-p", join(dir, "bin")]);
    writeFileSync(target, "old");
    publish("tampered", "0".repeat(64));
    const result = await install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(readFileSync(target, "utf8")).toBe("old");
  });

  it("fails clearly when the release has no asset for this host", async () => {
    routes["/releases/download/v9.9.9/checksums.txt"] = [200, {}, `${"a".repeat(64)}  other-asset\n`];
    routes[`/releases/download/v9.9.9/${asset}`] = [200, {}, "x"];
    const result = await install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no entry");
  });
});

describe("install kind", () => {
  const no = () => false;
  const yes = () => true;
  it("treats only a standalone binary in a writable folder as managed", () => {
    expect(detectInstallKind({ execPath: "/usr/local/bin/0", argv1: "/$bunfs/root/0", inContainer: no, writable: yes, platform: "darwin" }))
      .toEqual({ kind: "binary", managed: true, dir: "/usr/local/bin" });
    expect(detectInstallKind({ execPath: "/usr/local/bin/0", argv1: "/$bunfs/root/0", inContainer: no, writable: no, platform: "linux" }))
      .toMatchObject({ kind: "binary", managed: false, instruction: "0 doctor upgrade" });
    expect(detectInstallKind({ execPath: "/c/0/0.exe", argv1: "B:/~BUN/root/0", inContainer: no, writable: yes, platform: "win32" })).toMatchObject({ kind: "binary", managed: false });
  });
  it("never self-updates Docker, npm or a source checkout, and says what to run instead", () => {
    expect(detectInstallKind({ execPath: "/usr/local/bin/0", argv1: "/$bunfs/root/0", inContainer: yes, writable: yes })).toEqual({ kind: "docker", managed: false, instruction: "docker pull ghcr.io/0sec-labs/0security:latest" });
    expect(detectInstallKind({ execPath: "/usr/bin/node", argv1: "/usr/lib/node_modules/0sec-cli/dist/index.js", inContainer: no })).toMatchObject({ kind: "npm", managed: false });
    expect(detectInstallKind({ execPath: "/usr/bin/node", argv1: "/work/0/packages/cli/dist/index.js", inContainer: no, writable: yes })).toEqual({ kind: "source", managed: false, instruction: "git pull" });
    expect(detectInstallKind({ execPath: "/Users/a/.bun/bin/bun", argv1: "/work/0/src/index.ts", inContainer: no, writable: yes })).toMatchObject({ kind: "source", managed: false });
  });
});

describe("update policy default", () => {
  let home: string;
  let previous: string | undefined;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "0-policy-")); previous = process.env["HOME"]; process.env["HOME"] = home; });
  afterEach(() => { process.env["HOME"] = previous; rmSync(home, { recursive: true, force: true }); });
  const writeGlobal = (value: unknown) => { mkdirSync(join(home, ".0"), { recursive: true }); writeFileSync(join(home, ".0", "tui-settings.json"), JSON.stringify(value)); };

  it("is automatic for an install that never chose, including one with an unrelated saved settings file", () => {
    expect(resolveUpdatePolicy()).toBe("automatic");
    writeGlobal({ density: "compact" });
    expect(resolveUpdatePolicy()).toBe("automatic");
  });
  it("keeps an explicit choice", () => {
    for (const choice of ["off", "notify", "automatic"] as const) {
      writeGlobal({ updatePolicy: choice });
      expect(resolveUpdatePolicy()).toBe(choice);
    }
  });
});

describe.skipIf(!asset || !existsSync(installer))("self-update through the web update manager (fake release server, no network)", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "0-self-update-"));
    for (const key of ["HOME", "ZERO_UPDATE_ORIGIN", "INSTALL_FOXGUARD"]) saved[key] = process.env[key];
    process.env["HOME"] = join(dir, "home");
    process.env["INSTALL_FOXGUARD"] = "0";
    process.env["ZERO_UPDATE_ORIGIN"] = base;
    mkdirSync(join(dir, "home", ".0"), { recursive: true });
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  });

  function publish(body: string, checksum = createHash("sha256").update(body).digest("hex")) {
    routes["/latest"] = [200, { "content-type": "application/json" }, JSON.stringify({ tag_name: "v9.9.9" })];
    routes["/install.sh"] = [200, {}, readFileSync(installer)];
    routes["/releases/download/v9.9.9/checksums.txt"] = [200, {}, `${checksum}  ${asset}\n`];
    routes[`/releases/download/v9.9.9/${asset}`] = [200, {}, body];
  }
  function installedBinary(): string {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const target = join(bin, "0");
    writeFileSync(target, "#!/bin/sh\necho old\n");
    chmodSync(target, 0o755);
    return target;
  }

  it("downloads, verifies and swaps in the folder of the running binary, then the restart command runs the new program", async () => {
    const target = installedBinary();
    publish('#!/bin/sh\necho "new $*"\n');
    const restarts: Array<{ version: string; supervised: boolean }> = [];
    const manager = new UpdateManager({
      current: "0.0.1", serverMode: false, install: { kind: "binary", managed: true, dir: join(dir, "bin") }, supervised: false, env: {}, restartDelayMs: 0,
      threadCount: () => 0, policy: () => "automatic", restart: info => { restarts.push(info); },
      fetchLatest: () => fetchLatestTag(),
    });
    await manager.tick();                                   // background: finds 9.9.9 and installs it, nothing restarts yet
    expect(manager.status()).toMatchObject({ phase: "staged", latest: "9.9.9" });
    expect(readFileSync(target, "utf8")).toContain("new");
    const result = await manager.apply();
    expect(result).toEqual({ restarting: true, version: "9.9.9", supervised: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(restarts).toEqual([{ version: "9.9.9", supervised: false }]);
    const command = restartCommand({ execPath: target, argv: [target, "/$bunfs/root/0", "web", "--port", "0", "--db-path", "/d/x.db"], compiled: true, port: 48123 });
    expect(execFileSync(command.command, command.args, { encoding: "utf8" })).toBe("new web --db-path /d/x.db --port 48123 --no-open\n");
  });

  it("leaves the old program untouched when the checksum does not match", async () => {
    const target = installedBinary();
    publish("tampered", "0".repeat(64));
    const result = await performAutoUpdate({ version: "v9.9.9", installDir: join(dir, "bin"), quiet: true });
    expect(result.success).toBe(false);
    expect(readFileSync(target, "utf8")).toContain("old");
    const manager = new UpdateManager({
      current: "0.0.1", serverMode: false, install: { kind: "binary", managed: true, dir: join(dir, "bin") }, supervised: false, env: {}, restartDelayMs: 0,
      threadCount: () => 0, policy: () => "automatic", restart: () => { throw new Error("must not restart"); },
    });
    writeFileSync(join(dir, "home", ".0", "last-update-check"), JSON.stringify({ lastCheckedAt: new Date().toISOString(), latestVersion: "v9.9.9" }));
    await expect(manager.apply()).rejects.toMatchObject({ status: 502, code: "install_failed" });
    expect(readFileSync(target, "utf8")).toContain("old");
  });
});
