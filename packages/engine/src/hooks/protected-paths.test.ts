import { mkdirSync, mkdtempSync, rmSync, symlinkSync, realpathSync, writeFileSync } from "node:fs";
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
      "env -u ZERO_AGENT_SESSION node /x/index.js skills extensions add y --yes", "env -i 0 skills add x --yes", "sudo -u root 0 plugin enable x", "env --unset=ZERO_AGENT_SESSION 0 skills extensions enable x",
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
  }));
  it("still refuses state outside that folder", () => withHome(() => {
    {
      expect(protectedPathsBeforeCommandPolicy.evaluate(input("node ../../state.json"))).toMatchObject({ decision: "deny" });
      expect(protectedPathsBeforeCommandPolicy.evaluate(input("node server.mjs ~/.0/extensions/state.json"))).toMatchObject({ decision: "deny" });
      expect(protectedPathsBeforeCommandPolicy.evaluate(input("node server.mjs"))).toMatchObject({ decision: "allow" });
    }
  }));
});

describe("protected paths: running a file inside an installed extension", () => {
  const ext = "/home/op/.0/extensions/chat-notify/local-abc123";
  const run = (command: string, kind: BeforeCommandInput["kind"] = "bash", paths: string[] = []) => {
    const old = process.env["HOME"]; process.env["HOME"] = HOME;
    try { return protectedPathsBeforeCommandPolicy.evaluate({ kind, command, argv: [], cwd: "/work", hosts: [], paths, thread: {} }).decision; }
    finally { if (old === undefined) delete process.env["HOME"]; else process.env["HOME"] = old; }
  };
  it("allows running or reading a file in one revision folder", () => {
    expect(run(`bash ${ext}/scripts/notify.sh`)).toBe("allow");
    expect(run(`python3 ${ext}/scripts/notify.py --text hi`)).toBe("allow");
    expect(run(`cat ${ext}/extension.json`)).toBe("allow");
  });
  it("still refuses state, other writes and the extension folder itself", () => {
    for (const command of [
      "cat ~/.0/extensions/state.json", "cat ~/.0/extensions/connections.json", `bash ${ext}/../state.json`, `rm -rf ${ext}`, `rm ${ext}/scripts/notify.sh`,
      `echo x > ${ext}/scripts/notify.sh`, `tee ${ext}/scripts/notify.sh`, `sed -i s/a/b/ ${ext}/extension.json`, `cp /tmp/x ${ext}/scripts/x.sh`,
      `python3 -c "open('${ext}/scripts/x','w').write('y')"`, "ls ~/.0/extensions", "ls ~/.0/extensions/chat-notify",
    ]) expect(run(command), command).toBe("deny");
    expect(run("write", "file-write", [`${ext}/scripts/notify.sh`])).toBe("deny");
  });
});

describe("protected paths: sensitive state under ~/.0", () => {
  const withHome = <T>(fn: () => T): T => {
    const old = process.env["HOME"];
    process.env["HOME"] = HOME;
    try {
      return fn();
    } finally {
      if (old === undefined) delete process.env["HOME"];
      else process.env["HOME"] = old;
    }
  };

  const evaluateBash = (command: string, cwd = "/work") => withHome(() =>
    protectedPathsBeforeCommandPolicy.evaluate({
      kind: "bash", command, argv: command.split(/\s+/), cwd, hosts: [], paths: [], thread: {},
    })
  );

  const evaluateToolPaths = (paths: string[], kind: "file-write" | "file-read" = "file-write") => withHome(() =>
    protectedPathsBeforeCommandPolicy.evaluate({
      kind, command: kind === "file-write" ? "str_replace" : "read", argv: [], cwd: "/work", hosts: [], paths, thread: {},
    })
  );

  describe("newly protected sensitive files and directories are denied", () => {
    const sensitivePaths = [
      "engines.json",
      "engines/local.json",
      "workers/remote.env",
      "workers/managed.json",
      "github-webhook-secret.json",
      "findings-api-access/token",
      "teams/workspace-a/keys",
      "chatgpt-plan/accounts.json",
      "chatgpt-plan/write.lock",
      "web-connections.json",
      "workbench/state.json",
    ];

    it.each(sensitivePaths)("denies reading ~/.0/%s", path => {
      expect(evaluateBash(`cat ~/.0/${path}`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`cat /home/op/.0/${path}`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`cat $HOME/.0/${path}`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`cat "\${HOME}/.0/${path}"`)).toMatchObject({ decision: "deny" });
    });

    it.each(sensitivePaths)("denies writing to ~/.0/%s via redirection", path => {
      expect(evaluateBash(`echo 'hacked' > ~/.0/${path}`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`echo 'payload' >> ~/.0/${path}`)).toMatchObject({ decision: "deny" });
    });

    it.each(sensitivePaths)("denies deleting ~/.0/%s", path => {
      expect(evaluateBash(`rm ~/.0/${path}`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`rm -rf ~/.0/${path.split("/")[0]}`)).toMatchObject({ decision: "deny" });
    });

    it.each(sensitivePaths)("denies copying or moving ~/.0/%s", path => {
      expect(evaluateBash(`cp ~/.0/${path} /work/stolen.txt`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`mv ~/.0/${path} /work/stolen.txt`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`cp /tmp/evil ~/.0/${path}`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`mv /tmp/evil ~/.0/${path}`)).toMatchObject({ decision: "deny" });
    });

    it.each(sensitivePaths)("denies modifying ~/.0/%s with utilities (sed, tee, python, node)", path => {
      expect(evaluateBash(`sed -i 's/a/b/' ~/.0/${path}`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`echo evil | tee ~/.0/${path}`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`python3 -c "open('/home/op/.0/${path}').read()"`)).toMatchObject({ decision: "deny" });
      expect(evaluateBash(`node -e "require('fs').readFileSync('/home/op/.0/${path}')"`)).toMatchObject({ decision: "deny" });
    });

    it("denies access through directory traversal", () => {
      expect(evaluateBash("cat /work/../home/op/.0/engines.json")).toMatchObject({ decision: "deny" });
      expect(evaluateBash("cat /work/../../home/op/.0/github-webhook-secret.json")).toMatchObject({ decision: "deny" });
      expect(evaluateBash("cat /work/../home/op/.0/workers/remote.env")).toMatchObject({ decision: "deny" });
    });

    it("denies access after cd into directory under ~/.0", () => {
      expect(evaluateBash("cd ~/.0/workers && cat remote.env")).toMatchObject({ decision: "deny" });
      expect(evaluateBash("cd /home/op/.0/engines && cat local.json")).toMatchObject({ decision: "deny" });
      expect(evaluateBash("cd ~/.0 && cat engines.json")).toMatchObject({ decision: "deny" });
    });

    it("denies glob patterns matching newly protected paths", () => {
      expect(evaluateBash("cat ~/.0/eng*/local.json")).toMatchObject({ decision: "deny" });
      expect(evaluateBash("cat ~/.0/work*")).toMatchObject({ decision: "deny" });
      expect(evaluateBash("cat ~/.0/github-webhook*")).toMatchObject({ decision: "deny" });
      expect(evaluateBash("cat ~/.0/chatgpt*")).toMatchObject({ decision: "deny" });
    });

    it.each(sensitivePaths)("denies separate tool paths for ~/.0/%s", path => {
      expect(evaluateToolPaths([`/home/op/.0/${path}`], "file-write")).toMatchObject({ decision: "deny" });
      expect(evaluateToolPaths([`~/.0/${path}`], "file-read")).toMatchObject({ decision: "deny" });
    });
  });

  describe("workspace operations remain allowed (negative tests)", () => {
    it.each([
      "cat /work/engines.json",
      "cat ./engines.json",
      "echo '{\"engines\":[]}' > /work/engines.json",
      "cat /work/src/workers/worker.ts",
      "mkdir -p /work/workers && echo 'ok' > /work/workers/test.txt",
      "rm /work/engines.json",
      "cp /work/engines.json /work/engines.backup.json",
      "mv /work/engines.json /work/engines.renamed.json",
      "sed -i 's/foo/bar/' /work/engines.json",
      "cat /work/github-webhook-secret.json",
      "cat /work/web-connections.json",
      "cat /work/teams/report.md",
      "cat /work/chatgpt-plan/notes.txt",
      "cat /work/workbench/main.c",
      "cat /work/findings-api-access/keys.txt",
      "git status",
      "npm run build",
      "pnpm test",
    ])("allows workspace operation: %s", command => {
      expect(evaluateBash(command)).toEqual({ decision: "allow" });
    });

    it("allows tool paths targeting workspace files", () => {
      expect(evaluateToolPaths(["/work/engines.json"], "file-write")).toEqual({ decision: "allow" });
      expect(evaluateToolPaths(["/work/workers/worker.ts"], "file-read")).toEqual({ decision: "allow" });
      expect(evaluateToolPaths(["/work/github-webhook-secret.json"], "file-write")).toEqual({ decision: "allow" });
    });
  });

  describe("symlink resolution to sensitive paths", () => {
    let tmpDir: string;
    let fakeHome: string;
    let workDir: string;

    beforeAll(() => {
      tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "pp-sens-")));
      fakeHome = join(tmpDir, "h");
      workDir = join(tmpDir, "w");
      mkdirSync(join(fakeHome, ".0", "workers"), { recursive: true });
      writeFileSync(join(fakeHome, ".0", "engines.json"), "{}");
      mkdirSync(workDir, { recursive: true });
      symlinkSync(join(fakeHome, ".0", "workers"), join(workDir, "link-workers"));
      symlinkSync(join(fakeHome, ".0", "engines.json"), join(workDir, "link-engines.json"));
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("detects symlinks resolving to newly protected sensitive state", () => {
      expect(
        findProtectedPathUse("cat link-workers/remote.env", [], {
          home: fakeHome,
          cwd: workDir,
          real: realpathLoose,
        })
      ).not.toBeNull();

      expect(
        findProtectedPathUse("cat link-engines.json", [], {
          home: fakeHome,
          cwd: workDir,
          real: realpathLoose,
        })
      ).not.toBeNull();
    });
  });
});
