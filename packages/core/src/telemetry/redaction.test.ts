/**
 * Safety-layer tests for the analytics secret scrubber. Every credential
 * SHAPE must be removed and replaced by its typed token; truncation must
 * happen strictly after redaction; and any internal failure must drop the
 * field rather than leak the raw input.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REDACTION_CAP,
  REDACTED_AWS,
  REDACTED_EMAIL,
  REDACTED_GCP,
  REDACTED_GH,
  REDACTED_JWT,
  REDACTED_OPENAI,
  REDACTED_PEM,
  REDACTED_SECRET,
  REDACTED_SLACK,
  redactContent,
} from "./redaction.js";

// Real-looking (but fake) secrets.
const SK = "sk-abcdEFGH1234ijklMNOP5678qrstUVWX";
const GHP = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const AKIA = "AKIAIOSFODNN7EXAMPLE";
const AIZA = "AIzaSyA1234567890abcdefghijklmnopqrstuv";
// Split so the literal isn't a complete token in source (defeats secret
// scanners); the concatenated runtime value still exercises the xox- rule.
const XOXB = "xoxb-" + "1234567890-" + "ABCDEFGHIJKLMNOP";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdefABCDEF\nZZZZ0000zzzz1111\n-----END RSA PRIVATE KEY-----";
const OPERATOR_EMAIL = "sample.user@example.com";
const CONN = "postgres://dbuser:s3cr3tP@ss@db.internal:5432/prod";
const B64_60 = "QWxhZGRpbjpvcGVuU2VzYW1lMDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3A=";

describe("redactContent — credential shapes", () => {
  it("removes an sk- key and replaces it with the OpenAI token", () => {
    const out = redactContent(`key ${SK} end`);
    expect(out).not.toContain(SK);
    expect(out).toContain(REDACTED_OPENAI);
  });

  it("removes a GitHub token", () => {
    const out = redactContent(`token=${GHP}`);
    // Caught by either the assignment rule or the gh rule — never the raw value.
    expect(out).not.toContain(GHP);
    expect(out).toMatch(new RegExp(`${REDACTED_GH}|${REDACTED_SECRET}`));
  });

  it("removes an AWS access key id", () => {
    const out = redactContent(`aws ${AKIA} here`);
    expect(out).not.toContain(AKIA);
    // The audited header sweep tokenises AWS keys as <REDACTED-AWS-KEY>; our
    // own pass uses <REDACTED-AWS>. Either way the raw key is gone.
    expect(out).toContain("REDACTED-AWS");
  });

  it("removes a Google API key", () => {
    const out = redactContent(`gcp ${AIZA} x`);
    expect(out).not.toContain(AIZA);
    expect(out).toContain(REDACTED_GCP);
  });

  it("removes a Slack token", () => {
    const out = redactContent(`slack ${XOXB} x`);
    expect(out).not.toContain(XOXB);
    expect(out).toContain(REDACTED_SLACK);
  });

  it("removes a JWT", () => {
    const out = redactContent(`jwt ${JWT} x`);
    expect(out).not.toContain(JWT);
    expect(out).toContain(REDACTED_JWT);
  });

  it("removes a PEM private key block", () => {
    const out = redactContent(PEM);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA");
    expect(out).toContain(REDACTED_PEM);
  });

  it("redacts a credential-shaped assignment", () => {
    const out = redactContent(`password=hunter2secret`);
    expect(out).not.toContain("hunter2secret");
    expect(out).toContain(REDACTED_SECRET);
    // Keeps the key so the record is still meaningful.
    expect(out).toContain("password");
  });

  it("redacts a quoted assignment value", () => {
    const out = redactContent(`api_key = "abcd1234efgh5678"`);
    expect(out).not.toContain("abcd1234efgh5678");
    expect(out).toContain(REDACTED_SECRET);
  });

  it("redacts a high-entropy base64 blob (60 chars)", () => {
    const out = redactContent(`blob ${B64_60} end`);
    expect(out).not.toContain(B64_60);
    expect(out).toContain(REDACTED_SECRET);
  });
});

describe("redactContent — PII", () => {
  it("redacts an email, including the operator's own address", () => {
    const out = redactContent(`contact ${OPERATOR_EMAIL} for more`);
    expect(out).not.toContain(OPERATOR_EMAIL);
    expect(out).toContain(REDACTED_EMAIL);
  });

  it("redacts credentials inside a postgres connection string", () => {
    const out = redactContent(CONN);
    expect(out).not.toContain("dbuser");
    expect(out).not.toContain("s3cr3tP");
    expect(out).toContain(REDACTED_SECRET);
    // Endpoint shape survives so the record stays legible.
    expect(out).toContain("postgres://");
  });
});

describe("redactContent — exact target-auth values", () => {
  it("removes operator-supplied auth secrets by exact match", () => {
    const secret = "my-target-session-cookie-value";
    const out = redactContent(`Cookie carried ${secret} inline`, {
      authSecretValues: [secret],
    });
    expect(out).not.toContain(secret);
  });
});

describe("redactContent — truncation after redaction", () => {
  it("caps at the default length only after secrets are tokenised", () => {
    const filler = "a".repeat(DEFAULT_REDACTION_CAP);
    const out = redactContent(`${filler}${SK}`);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_REDACTION_CAP + 3); // + "..."
    expect(out).not.toContain(SK);
  });

  it("a secret sitting right at the cap boundary is never split into a leaking prefix", () => {
    // Place the secret so the cap falls in the MIDDLE of where it was. Because
    // redaction runs first, only the placeholder token can be cut — never the
    // secret. We assert no non-trivial prefix of the raw key survives.
    const cap = 20;
    const out = redactContent(`prefix-${SK}-suffix`, { maxChars: cap });
    expect(out).not.toContain(SK);
    // No 8+ char run of the original key leaks (a split token exposes nothing).
    expect(out).not.toContain(SK.slice(0, 8));
    expect(out.length).toBeLessThanOrEqual(cap + 3);
  });

  it("honours a caller-supplied cap", () => {
    const out = redactContent("x".repeat(100), { maxChars: 10 });
    expect(out).toBe(`${"x".repeat(10)}...`);
  });
});

describe("redactContent — default-deny", () => {
  it("returns '' (drops the field) when a redactor throws", () => {
    // Force a redaction pass to throw: the audited `redactAuthValues` iterates
    // `authSecretValues` via `new Set(...)`, so an object whose iterator throws
    // makes the first pass blow up. We must return "" rather than the raw text.
    const hostile = {
      length: 1,
      [Symbol.iterator]() {
        throw new Error("boom");
      },
    } as unknown as readonly string[];
    const out = redactContent(`leak ${SK} here`, { authSecretValues: hostile });
    expect(out).toBe("");
    expect(out).not.toContain(SK);
  });

  it("returns '' for empty or non-string input", () => {
    expect(redactContent("")).toBe("");
    // @ts-expect-error deliberate misuse
    expect(redactContent(undefined)).toBe("");
    // @ts-expect-error deliberate misuse
    expect(redactContent(null)).toBe("");
  });
});
