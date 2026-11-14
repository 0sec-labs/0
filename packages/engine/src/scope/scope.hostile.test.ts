import { describe, expect, it } from "vitest";
import { ScopePolicy } from "./scope.js";

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; }; }
const allow = (rules: string[], deny: string[] = []) => ScopePolicy.fromJson({ in_scope: rules, out_of_scope: deny } as never);

describe("scope policy under hostile URLs", () => {
  const policy = allow(["example.com", "*.corp.example", "10.0.0.0/8"], ["10.9.0.0/16", "admin.example.com"]);
  it.each([
    "http://example.com.evil.com/",
    "http://evil.com/?u=example.com",
    "http://evil.com/#@example.com",
    "http://example.com@evil.com/",
    "http://example.com:pw@evil.com/",
    "http://evil.com\\@example.com/",
    "http://notexample.com/",
    "http://corp.example/",
    "http://xcorp.example/",
    "http://11.0.0.1/",
    "http://admin.example.com/",
    "http://ADMIN.EXAMPLE.COM./",
    "http://10.9.1.1/",
    "http://0x0a.9.1.1/",
    "http://168361985/",
    "http://[::ffff:10.9.1.1]/",
    "http://[::ffff:a09:101]/",
    "file:///etc/passwd",
    "ftp://example.org/",
    "javascript:alert(1)",
    "data:text/html,example.com",
    "",
    "example.com",
    "http://",
    "http://exam\u0000ple.com/",
  ])("denies %j", url => {
    expect(policy.match(url).allowed, policy.match(url).reason).toBe(false);
  });

  it("allows only legitimate in-scope spellings", () => {
    for (const url of ["http://example.com/", "https://EXAMPLE.com:8443/x", "http://example.com./", "http://a.corp.example/", "http://10.1.2.3/", "http://user:pw@example.com/", "http://0xa.1.2.3/", "http://167838211/"]) {
      expect(policy.match(url).allowed, url).toBe(true);
    }
  });

  it("denies an IPv4-mapped IPv6 literal of a denied IPv4 range (bracketed or not)", () => {
    expect(policy.match("http://[::ffff:10.9.1.1]/").allowed).toBe(false);
  });

  it("never throws on random hostile URLs and never allows hosts outside the rules", () => {
    const rand = rng(42);
    const parts = ["http://", "https://", "@", ":", "/", "\\", "#", "?", "%2e", "%00", "..", ".", "evil.com", "example.com", "[::1]", "[::ffff:10.0.0.1]", "xn--e1afmkfd", "пример", "10.", "0x7f", "\u0000", "\ud800", " ", "\t", "\n"];
    for (let i = 0; i < 3000; i++) {
      let url = ""; const n = 1 + Math.floor(rand() * 8);
      for (let j = 0; j < n; j++) url += parts[Math.floor(rand() * parts.length)];
      const result = policy.match(url);
      if (result.allowed) {
        const host = new URL(url).hostname;
        expect(/(^|\.)example\.com\.?$|\.corp\.example\.?$|^10\./i.test(host) || /^\[?::ffff:/.test(host), `${JSON.stringify(url)} -> ${host}`).toBe(true);
      }
    }
  });

  it("rejects malformed policy documents with an error and never constructs a permissive policy", () => {
    const rand = rng(7);
    const junk: unknown[] = [null, 1, "x", [], {}, { in_scope: "a" }, { in_scope: [1] }, { in_scope: [""] }, { in_scope: ["::/0"] }, { in_scope: ["0.0.0.0/"] }, { in_scope: ["10.0.0.0/8/9"] }, { in_scope: ["*"] }, { in_scope: ["a.*.b"] }, { in_scope: ["*."] }, { in_scope: { length: 1, 0: "a" } }, { in_scope: ["a"], out_of_scope: "b" }, { in_scope: ["300.0.0.0/8"] }, { in_scope: ["1.2.3.4/33"] }, { in_scope: ["1.2.3.4/-1"] }];
    for (const doc of junk) {
      let policy: ScopePolicy | undefined;
      try { policy = ScopePolicy.fromJson(doc as never); } catch (error) { expect(error).toBeInstanceOf(Error); continue; }
      // Accepted documents must not be an allow-all.
      expect(policy.match("http://evil.example.net/").allowed, JSON.stringify(doc)).toBe(false);
      expect(policy.match("http://8.8.8.8/").allowed, JSON.stringify(doc)).toBe(false);
    }
    void rand;
  });
});
