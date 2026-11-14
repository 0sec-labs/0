import { describe, it, expect } from "vitest";
import { classifyBashCommand, classifyToolRisk } from "./destructive-classifier.js";
import type { ToolCall } from "./types.js";

describe("classifyBashCommand — positive destructive matches (directly invoked, accepted syntax)", () => {
  it("flags recursive rm in its several flag spellings", () => {
    for (const cmd of ["rm -rf /tmp/x", "rm -fr /tmp/x", "rm -r /tmp/x", "rm -R /tmp/x", "rm --recursive /tmp/x"]) {
      const risk = classifyBashCommand(cmd);
      expect(risk.level, cmd).toBe("destructive");
      expect(risk.category, cmd).toBe("recursive-delete");
    }
  });

  it("resolves the basename of a path-qualified command, and allows glob args", () => {
    expect(classifyBashCommand("/bin/rm -rf /var/x").category).toBe("recursive-delete");
    expect(classifyBashCommand("rm -rf /tmp/*").category).toBe("recursive-delete"); // glob is an ordinary arg
  });

  it("flags a destructive head after a REAL separator", () => {
    expect(classifyBashCommand("echo hi; rm -rf /tmp/y").category).toBe("recursive-delete");
    expect(classifyBashCommand("ls | rm -rf x").category).toBe("recursive-delete");
    expect(classifyBashCommand("false && rm -rf /tmp/z").category).toBe("recursive-delete");
  });

  it("classifies disk and filesystem destroyers", () => {
    expect(classifyBashCommand("dd if=/dev/zero of=/dev/sda").category).toBe("disk-write");
    expect(classifyBashCommand("mkfs.ext4 /dev/sdb").category).toBe("filesystem-format");
    expect(classifyBashCommand("mkfs /dev/sdb").category).toBe("filesystem-format");
    expect(classifyBashCommand("wipefs -a /dev/sdb").category).toBe("filesystem-format");
    expect(classifyBashCommand("shred -u secret.key").category).toBe("recursive-delete");
  });

  it("classifies hard process kills and broad killers", () => {
    expect(classifyBashCommand("killall -9 node").category).toBe("process-kill");
    expect(classifyBashCommand("pkill -f server").category).toBe("process-kill");
    expect(classifyBashCommand("kill -9 1234").category).toBe("process-kill");
    expect(classifyBashCommand("kill -KILL 1234").category).toBe("process-kill");
  });

  it("classifies git history rewrites (plain subcommand form)", () => {
    expect(classifyBashCommand("git reset --hard HEAD~1").category).toBe("repo-history-rewrite");
    expect(classifyBashCommand("git clean -fd").category).toBe("repo-history-rewrite");
    expect(classifyBashCommand("git push --force origin main").category).toBe("repo-history-rewrite");
    expect(classifyBashCommand("git push -f").category).toBe("repo-history-rewrite");
  });
});

describe("classifyBashCommand — conservative UNKNOWN (never a false destructive, never safe)", () => {
  it("does not flag non-recursive rm or benign kills/git", () => {
    expect(classifyBashCommand("rm file.txt").level).toBe("unknown");
    expect(classifyBashCommand("kill 1234").level).toBe("unknown");
    expect(classifyBashCommand("git status").level).toBe("unknown");
    expect(classifyBashCommand("dd if=/dev/sda | gzip").level).toBe("unknown"); // read side, no of=
  });

  it("treats empty / whitespace commands as unknown", () => {
    expect(classifyBashCommand("").level).toBe("unknown");
    expect(classifyBashCommand("   \n\t ").level).toBe("unknown");
  });
});

describe("classifyBashCommand — syntax OUTSIDE the accepted subset is unknown (not guessed)", () => {
  it("rejects quotes (origin is lost by the tokenizer)", () => {
    expect(classifyBashCommand('echo "rm -rf /"').level).toBe("unknown");
    expect(classifyBashCommand("echo 'safe; rm -rf /'").level).toBe("unknown");
    expect(classifyBashCommand("sh -c 'rm -rf /'").level).toBe("unknown");
  });

  it("rejects backslash escapes, comments and heredocs (they defeat naive splitting)", () => {
    expect(classifyBashCommand("printf %s \\; rm -rf example").level).toBe("unknown"); // escaped ;
    expect(classifyBashCommand("echo ok # ; rm -rf example").level).toBe("unknown");   // comment
    expect(classifyBashCommand("cat <<EOF\nrm -rf example\nEOF").level).toBe("unknown"); // heredoc / redirect
  });

  it("rejects substitution and expansion", () => {
    expect(classifyBashCommand("eval \"rm -rf /\"").level).toBe("unknown");
    expect(classifyBashCommand("rm -rf $HOME").level).toBe("unknown");
    expect(classifyBashCommand("rm$IFS-rf /").level).toBe("unknown");
    expect(classifyBashCommand("rm -rf $(cat list)").level).toBe("unknown");
  });
});

describe("classifyBashCommand — no shell-semantics modeling (adversarial regressions)", () => {
  it("does not model wrapper/prefix programs — sudo/env/command are unknown, not their argv", () => {
    expect(classifyBashCommand("sudo rm -rf /").level).toBe("unknown");
    expect(classifyBashCommand("env FOO=bar rm -rf /var/x").level).toBe("unknown");
    expect(classifyBashCommand("command -v rm -rf example").level).toBe("unknown"); // introspection
    expect(classifyBashCommand("xargs rm -rf").level).toBe("unknown");
  });

  it("does not treat an inherited Object.prototype name as anything special", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(classifyBashCommand(`${name} rm -rf example`).level, name).toBe("unknown");
    }
  });

  it("models git only in the plainest subcommand-first form", () => {
    expect(classifyBashCommand("git grep -- --hard reset").level).toBe("unknown"); // subcommand is grep
    expect(classifyBashCommand("git --version reset --hard").level).toBe("unknown"); // terminating global option
    expect(classifyBashCommand("git -C /repo reset --hard").level).toBe("unknown"); // unmodeled global option
    expect(classifyBashCommand("git show HEAD --hard").level).toBe("unknown"); // subcommand is show
  });

  it("respects -- end-of-options and dry-run/help as non-destructive", () => {
    expect(classifyBashCommand("rm -- -rf").level).toBe("unknown"); // deletes a file literally named -rf
    expect(classifyBashCommand("git clean -n -f").level).toBe("unknown"); // dry run
    expect(classifyBashCommand("git push --dry-run --force").level).toBe("unknown");
    expect(classifyBashCommand("rm -rf --help").level).toBe("unknown");
  });

  it("matches command names case-sensitively (POSIX)", () => {
    expect(classifyBashCommand("RM -rf /tmp/x").level).toBe("unknown");
  });
});

describe("classifyToolRisk — only the bash tool's command is analysed", () => {
  const call = (name: string, args: Record<string, unknown>): ToolCall => ({ name, arguments: args });

  it("classifies the bash tool's command string", () => {
    expect(classifyToolRisk(call("bash", { command: "rm -rf /tmp/x" })).level).toBe("destructive");
    expect(classifyToolRisk(call("bash", { command: "ls -la" })).level).toBe("unknown");
  });

  it("never claims destructive for non-bash tools or malformed input", () => {
    expect(classifyToolRisk(call("write_file", { path: "/etc/passwd", content: "x" })).level).toBe("unknown");
    expect(classifyToolRisk(call("run_command", { command: "rm -rf /" })).level).toBe("unknown"); // never reaches here anyway
    expect(classifyToolRisk(call("bash", {})).level).toBe("unknown");
    expect(classifyToolRisk(call("bash", { command: 42 })).level).toBe("unknown");
  });
});

