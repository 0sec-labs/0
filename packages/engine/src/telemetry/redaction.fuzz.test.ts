import { describe, expect, it } from "vitest";
import { redactContent } from "./redaction.js";
import { redactSensitiveHeaders } from "../disclose/template.js";

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; }; }
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const rand = rng(2024);
const str = (n: number, alphabet = ALNUM) => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
const secrets: Array<() => string> = [
  () => `sk-${str(20 + Math.floor(rand() * 30))}`,
  () => `sk-ant-api03-${str(40)}-${str(10)}`,
  () => `ghp_${str(36)}`,
  () => `github_pat_${str(40)}`,
  () => `AKIA${str(16, UP)}`,
  () => `AIza${str(35)}`,
  () => `xoxb-${str(12)}-${str(12)}`,
  () => `eyJ${str(20)}.${str(20)}.${str(20)}`,
];
const contexts: Array<(s: string) => string> = [
  s => s,
  s => `key is ${s} ok`,
  s => `{"data":"${s}"}`,
  s => JSON.stringify({ nested: { arr: [`prefix ${s} suffix`] } }),
  s => JSON.stringify({ message: `line1\nuse ${s}\nline3` }),
  s => `https://api.example.com/v1?key=${s}&x=1`,
  s => `curl -H 'X-Custom: ${s}' https://x`,
  s => `export TOKEN=${s}`,
  s => `\`\`\`\n${s}\n\`\`\``,
  s => `<${s}>`,
  s => `(${s}),`,
  s => `日本語${s}日本語`,
  s => `Authorization: Bearer ${s}`,
  s => `"${s}"`,
  s => `${s}\u0000tail`,
  s => `a\r\n${s}\r\nb`,
  s => `\\"${s}\\"`,
];
const withoutKnownShapeBoundaryGaps = (secret: string, out: string) => !out.includes(secret);

describe("redactContent never leaks recognised credential shapes", () => {
  it("across 600 random secret/context pairs", () => {
    const failures: string[] = [];
    for (let i = 0; i < 600; i++) {
      const secret = secrets[i % secrets.length]!();
      const context = contexts[Math.floor(rand() * contexts.length)]!;
      const input = context(secret);
      const out = redactContent(input, { maxChars: Number.POSITIVE_INFINITY });
      if (!withoutKnownShapeBoundaryGaps(secret, out)) failures.push(JSON.stringify(input));
    }
    expect(failures).toEqual([]);
  });

  it("redacts credential-named CLI flags and bounds work on long dash-separated runs", () => {
    expect(redactContent("tool --token=hunter2hunter2 --api-key=abcdef123456 x")).not.toMatch(/hunter2|abcdef123456/);
    for (const unit of ["sk-", "a-"]) {
      const start = Date.now();
      redactContent(unit.repeat(40_000));
      expect(Date.now() - start).toBeLessThan(2000);
    }
  });

  it("never leaks a prefix when truncating", () => {
    const secret = `sk-${str(40)}`;
    for (let cap = 5; cap < 120; cap += 7) {
      const out = redactContent(`${"x".repeat(Math.max(0, cap - 10))} ${secret}`, { maxChars: cap });
      expect(out).not.toContain("sk-");
    }
  });

  it("returns a string for lone surrogates, NUL and huge input without throwing", () => {
    for (const input of ["\ud800sk-" + str(30), "\u0000".repeat(1000), "sk-".repeat(20_000), "{".repeat(50_000), "[" + '"a",'.repeat(50_000) + "]"]) {
      expect(typeof redactContent(input)).toBe("string");
    }
  });
});

describe("redactSensitiveHeaders", () => {
  it("masks AWS keys and auth headers in any context", () => {
    for (let i = 0; i < 100; i++) {
      const aws = `AKIA${str(16, UP)}`;
      const out = redactSensitiveHeaders(contexts[Math.floor(rand() * contexts.length)]!(aws));
      expect(out).not.toContain(aws);
    }
    for (const eol of ["\n", "\r\n"]) {
      const out = redactSensitiveHeaders(`GET / HTTP/1.1${eol}Host: x${eol}Authorization: Basic dXNlcjpwYXNz${eol}Cookie: sid=abc123${eol}X-API-Key: k-123456${eol}`);
      expect(out).not.toMatch(/dXNlcjpwYXNz|abc123|k-123456/);
    }
  });
});
