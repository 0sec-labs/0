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

  it.each([GHP, `github_pat_${"a".repeat(32)}`])("removes the GitHub credential shape %s", (key) => {
    const out = redactContent(`credential ${key} end`);
    expect(out).not.toContain(key);
    expect(out).toContain(REDACTED_GH);
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

  it.each([JWT, "eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl"])("removes JWT credentials including compact claims: %s", (jwt) => {
    const out = redactContent(`jwt ${jwt} x`);
    expect(out).not.toContain(jwt);
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

});

describe("redactContent — credential-only capture", () => {
  it("preserves email, opaque content, ordinary URLs and non-credential identifiers", () => {
    const text = [
      `contact ${OPERATOR_EMAIL}`,
      `const encoded = "${B64_60}";`,
      `https://${"ordinary-subdomain".repeat(5)}.example.com/artifacts?id=${B64_60}`,
      "KEYBOARD_LAYOUT=us",
      "MONKEY=chimp",
      "PUBLIC_KEY=published-material",
      "TOKEN_COUNT=42",
      'const data = {"\\x63ontact":"sample.user@example.com"};',
    ].join("\n");
    expect(redactContent(text)).toBe(text);
  });

  it("scrubs quoted credential fields without changing ordinary JSON values", () => {
    const input = {
      contact: OPERATOR_EMAIL,
      blob: B64_60,
      password: 'quoted"password\\value',
      userPassword: "camel-case-credential",
      api_key: "plain-api-credential",
      APP_SECRET: "app-credential",
      AWS_SECRET_ACCESS_KEY: "aws-credential",
      headers: { Authorization: "Basic dXNlcjpwYXNz", Cookie: "sid=private-session" },
    };
    const out = JSON.parse(redactContent(JSON.stringify(input)));
    expect(out).toEqual({
      ...input,
      password: REDACTED_SECRET,
      userPassword: REDACTED_SECRET,
      api_key: REDACTED_SECRET,
      APP_SECRET: REDACTED_SECRET,
      AWS_SECRET_ACCESS_KEY: REDACTED_SECRET,
      headers: { Authorization: REDACTED_SECRET, Cookie: REDACTED_SECRET },
    });
  });

  it("scrubs shell credentials nested in JSON-stringified tool arguments", () => {
    const input = {
      cmd: 'curl -H "Cookie: sid=private-session" --data \'password="private-password"\' https://example.com',
      contact: OPERATOR_EMAIL,
    };
    const text = redactContent(JSON.stringify(input));
    expect(text).not.toContain("private-session");
    expect(text).not.toContain("private-password");
    const out = JSON.parse(text);
    expect(out.contact).toBe(OPERATOR_EMAIL);
    expect(out.cmd).toContain("https://example.com");
  });

  it("preserves duplicate ordinary JSON keys and whitespace while scrubbing credentials", () => {
    const input = '{ "message":"keep-first", "message":"keep-second", "password":"synthetic-secret" }\n';
    expect(redactContent(input)).toBe(input.replace("synthetic-secret", REDACTED_SECRET));
  });

  it("scrubs earlier duplicate credential-bearing values, including escaped shell commands", () => {
    const nested = JSON.stringify('curl --data \'password="hidden-password"\' https://example.com');
    const input = `{"value":${JSON.stringify(SK)},"value":"ordinary","cmd":${nested},"cmd":"retained"}`;
    const out = redactContent(input);
    expect(out).not.toContain(SK);
    expect(out).not.toContain("hidden-password");
    expect(out.match(/"value":/g)).toHaveLength(2);
    expect(out.match(/"cmd":/g)).toHaveLength(2);
    expect(JSON.parse(out)).toEqual({ value: "ordinary", cmd: "retained" });
  });

  it("scrubs complete structured credential values without disturbing adjacent data", () => {
    const input = '{ "credentials":{"nested":[1,{"opaque":"hidden"}]}, "password":12345, "email":"sample.user@example.com" }';
    expect(redactContent(input)).toBe(`{ "credentials":"${REDACTED_SECRET}", "password":"${REDACTED_SECRET}", "email":"sample.user@example.com" }`);
  });

  it("removes complete URL credentials while retaining the endpoint", () => {
    expect(redactContent(CONN)).toBe(`postgres://${REDACTED_SECRET}@db.internal:5432/prod`);
  });
});

describe("redactContent — exact target-auth values", () => {
  it("removes operator-supplied auth secrets by exact match", () => {
    // Synthetic cookie value exercises exact-match scrubbing.
    // foxguard: ignore[js/no-hardcoded-secret]
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
    expect(out.length).toBeLessThanOrEqual(DEFAULT_REDACTION_CAP);
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
    expect(out.length).toBeLessThanOrEqual(cap);
  });

  it("honours a caller-supplied cap", () => {
    const out = redactContent("x".repeat(100), { maxChars: 10 });
    expect(out).toBe(`${"x".repeat(7)}...`);
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
