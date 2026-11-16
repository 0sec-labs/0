import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SourceRecord } from "../core/prompt.js";
import { getBuiltin } from "../core/builtins.js";
import { err, ok, type Result } from "../core/result.js";
import type { ExtensionSource, SourceResolver } from "../ports.js";
import { FULL_SHA, GitSource } from "./git-source.js";
import { LocalSource } from "./local-source.js";

const GITHUB = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * `https://host/repo@<sha>`, `owner/repo@<sha>`, `/path/to/git/repo@<sha>`, a local folder, or a built-in name.
 * Only a FULL 40-character SHA pins; branches, tags and short SHAs are refused rather than guessed.
 */
export class DefaultSourceResolver implements SourceResolver {
  constructor(private readonly home: string = process.env["HOME"] || homedir()) {}

  resolve(input: string): Result<{ source: ExtensionSource } | { builtin: string }> {
    const text = input.trim();
    if (!text) return err("bad_source", "Give a source: url@sha, a folder, or a built-in extension name.");
    const name = text.replace(/^builtin:/, "");
    if (getBuiltin(name) && (text.startsWith("builtin:") || !text.includes("/"))) return ok({ builtin: name });
    let base = text; let sha: string | undefined;
    const at = text.lastIndexOf("@");
    if (at > 0 && !text.slice(at + 1).includes("/") && !text.slice(at + 1).includes(":")) {
      const tail = text.slice(at + 1);
      if (FULL_SHA.test(tail)) { base = text.slice(0, at); sha = tail; }
      else return err("bad_source", "Pin with the full 40-character commit SHA (source@<sha>); branches, tags and short SHAs are not stored.");
    }
    if (/^(ssh:|git@|git:|http:|file:)/i.test(base)) return err("bad_source", "Only https:// URLs, owner/repo, or local paths are supported.");
    if (/^https:\/\//i.test(base)) {
      let url: URL; try { url = new URL(base); } catch { return err("bad_source", "Invalid URL."); }
      if (url.username || url.password || url.search || url.hash) return err("bad_source", "The URL must not contain credentials, a query or a fragment.");
      return ok({ source: new GitSource(url.href, sha ?? null, false) });
    }
    const expanded = base.startsWith("~/") ? join(this.home, base.slice(2)) : base;
    const pathLike = /^(\/|\.\/|\.\.\/)/.test(expanded) || (!GITHUB.test(base) && existsSync(expanded));
    if (!pathLike && GITHUB.test(base)) return ok({ source: new GitSource(`https://github.com/${base}.git`, sha ?? null, false) });
    const path = resolve(expanded);
    if (!existsSync(path)) return err("bad_source", `${input} is not a folder, an owner/repo, or an https URL.`);
    return ok({ source: sha ? new GitSource(path, sha, true) : new LocalSource(path) });
  }

  fromRecord(record: SourceRecord, pin?: string): Result<ExtensionSource> {
    if (pin !== undefined && !FULL_SHA.test(pin)) return err("bad_source", "Update to a full 40-character commit SHA.");
    return ok(record.type === "git" ? new GitSource(record.url, pin ?? null, record.url.startsWith("/")) : new LocalSource(record.path));
  }
}
