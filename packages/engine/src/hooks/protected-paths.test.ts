import { mkdirSync, mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BeforeCommandInput } from "./before-command.js";
import { findApprovalCommand, findProtectedPathUse } from "./protected-paths.js";
import { protectedPathsBeforeCommandPolicy } from "./protected-paths-policy.js";
import { realpathLoose } from "./real-path.js";

const HOME = "/home/op";
const ctx = (cwd = "/work") => ({ home: HOME, cwd });
const hit = (command: string, cwd?: string, paths: string[] = []) => findProtectedPathUse(command, paths, ctx(cwd));

describe("protected paths: text analysis", () => {
  it.each([
    "cat /home/op/.0/extensions/state.json",
    "cat ~/.0/extensions/state.json",
    "cat $HOME/.0/extensions/state.json",
    'cat "${HOME}/.0/extensions/audit.jsonl"',
    "echo '{}' > ~/.0/extensions/state.json",
    "echo x >>~/.0/plugin-enablement/a.json",
    "echo x | tee ~/.0/plugins/p/plugin.js",
    "cp /tmp/evil.json ~/.0/extensions/state.json",
    "mv /tmp/x ~/.0/plugins/x",
    "ln -s /tmp/x ~/.0/extensions/x",
    "sed -i 's/a/b/' ~/.0/extensions/state.json",
    `python3 -c "open('/home/op/.0/extensions/state.json','w').write('{}')"`,
    `node -e "require('fs').writeFileSync(process.env.HOME + '/x', 1); require('fs').rmSync('~/.0/extensions',{recursive:true})"`,
    "cat /work/../home/op/.0/extensions/state.json",
    "cat ~/.0/ext*/state.json",
    "cat ~/.0/e?tensions/state.json",
    "cat ~/.0/*/state.json",
    "cat ~/.0/0.db",
    "cat ~/.0/tui-settings.json",
    "rm -rf ~/.0",
  ])("flags %s", command => { expect(hit(command)).not.toBeNull(); });

  it("follows cd and pushd into relative paths", () => {
    expect(hit("cd ~/.0 && cat extensions/state.json")).not.toBeNull();
    expect(hit("cd /home/op/.0/extensions; echo x > state.json")).not.toBeNull();
    expect(hit("cd ~ && cd .0 && cat plugins/x/plugin.js")).not.toBeNull();
    expect(hit("echo x > state.json", "/home/op/.0/extensions")).not.toBeNull();
    expect(hit("cat extensions/state.json", "/home/op/.0")).not.toBeNull();
  });

  it("flags tool paths passed separately from the command", () => {
    expect(hit("", "/work", ["/home/op/.0/extensions/state.json"])).not.toBeNull();
    expect(hit("", "/work", ["~/.0/plugins/x"])).not.toBeNull();
    expect(hit("", "/home/op/.0", ["extensions/state.json"])).not.toBeNull();
  });

  it("does not crash on odd glob characters and still flags a real one", () => {
    expect(() => hit('printf x > "/tmp/a[b" ; cat ~/.0/ext[')).not.toThrow();
    expect(hit("cat ~/.0/ext[a-z]nsions/state.json")).not.toBeNull();
    expect(hit('{"command":"printf x > \\"/home/x/effect\\"","files":{"a[0":1}}')).toBeNull();
  });

  it("leaves ordinary commands and other state alone", () => {
    for (const command of ["ls -la", "cat /work/README.md", "cat ~/.0/runs/x/log.txt", "ls ~/.0", "echo extensions > notes.txt", "git status", "cat ~/.bashrc", "cd /tmp && ls"]) {
      expect(hit(command), command).toBeNull();
    }
  });

  it("flags approval-bearing CLI commands wherever they are in a pipeline", () => {
    for (const command of [
      "0 skills add github.com/x/y@" + "a".repeat(40) + " --yes --enable",
      "0 skills extensions enable x --yes", "0 skills extensions update x --yes --to abc", "0 skills extensions import --force",
      "FOO=1 0 skills extensions disable scope --yes", "cd /tmp && 0 plugin enable scope", "env 0 skills list foo --yes", "sudo 0 plugin disable scope",
    ]) expect(findApprovalCommand(command), command).not.toBeNull();
    for (const command of ["0 skills list", "0 skills extensions list", "0 skills extensions info x", "echo 0 skills add", "ls"]) expect(findApprovalCommand(command), command).toBeNull();
  });
});

describe("protected paths: symlinks and the policy", () => {
  let dir: string; let home: string; let saved: string | undefined;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "pp-"))); home = join(dir, "h");
    mkdirSync(join(home, ".0", "extensions"), { recursive: true }); mkdirSync(join(dir, "w"));
    symlinkSync(join(home, ".0", "extensions"), join(dir, "w", "innocent"));
    saved = process.env["HOME"]; process.env["HOME"] = home;
  });
  afterAll(() => { if (saved === undefined) delete process.env["HOME"]; else process.env["HOME"] = saved; rmSync(dir, { recursive: true, force: true }); });
  const input = (over: Partial<BeforeCommandInput>): BeforeCommandInput => ({ kind: "bash", command: "", argv: [], cwd: join(dir, "w"), hosts: [], paths: [], thread: {}, ...over });

  it("resolves an existing symlink to its target", () => {
    expect(findProtectedPathUse("echo x > innocent/state.json", [], { home, cwd: join(dir, "w"), real: realpathLoose })).not.toBeNull();
    expect(findProtectedPathUse("echo x > innocent/state.json", [], { home, cwd: join(dir, "w") })).toBeNull();
  });

  it("denies bash, process, file-write and file-read with a reason that names the operator", async () => {
    for (const kind of ["bash", "process"] as const) {
      const r = await protectedPathsBeforeCommandPolicy.evaluate(input({ kind, command: "cat innocent/state.json" }));
      expect(r).toMatchObject({ decision: "deny" });
      expect((r as { reason: string }).reason).toContain("operator");
    }
    for (const kind of ["file-write", "file-read"] as const) {
      expect(await protectedPathsBeforeCommandPolicy.evaluate(input({ kind, command: "str_replace", paths: [join(home, ".0", "extensions", "state.json")] }))).toMatchObject({ decision: "deny" });
    }
    expect(await protectedPathsBeforeCommandPolicy.evaluate(input({ command: "0 skills extensions enable x --yes" }))).toMatchObject({ decision: "deny" });
  });

  it("allows ordinary work and ignores network calls", async () => {
    expect(await protectedPathsBeforeCommandPolicy.evaluate(input({ command: "ls -la" }))).toEqual({ decision: "allow" });
    expect(await protectedPathsBeforeCommandPolicy.evaluate(input({ kind: "network", command: "curl ~/.0/extensions" }))).toEqual({ decision: "allow" });
  });
});

describe("protected paths: an extension starting its own server", () => {
  const dir = "/home/op/.0/extensions/demo/abc123";
  const input = (command: string): BeforeCommandInput => ({ kind: "process", command, argv: command.split(" "), cwd: dir, hosts: [], paths: [], thread: {}, effectful: true, extensionDir: dir });
  const withHome = (fn: () => void) => { const old = process.env["HOME"]; process.env["HOME"] = HOME; try { fn(); } finally { if (old === undefined) delete process.env["HOME"]; else process.env["HOME"] = old; } };
  it("allows naming files inside its own folder", () => withHome(() => {
    expect(protectedPathsBeforeCommandPolicy.evaluate(input("node server.mjs")).decision).toBe("allow");
    expect(protectedPathsBeforeCommandPolicy.evaluate({ ...input("node server.mjs"), extensionDir: undefined })).toMatchObject({ decision: "deny" });
  }));
  it("still refuses state outside that folder", () => withHome(() => {
    {
      expect(protectedPathsBeforeCommandPolicy.evaluate(input("node ../../state.json"))).toMatchObject({ decision: "deny" });
      expect(protectedPathsBeforeCommandPolicy.evaluate(input("node server.mjs ~/.0/extensions/state.json"))).toMatchObject({ decision: "deny" });
      expect(protectedPathsBeforeCommandPolicy.evaluate(input("node server.mjs"))).toMatchObject({ decision: "allow" });
    }
  }));
});
