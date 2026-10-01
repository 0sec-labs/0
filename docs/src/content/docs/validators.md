---
title: Finding Validators
description: What the category-specific runtime validators check, how to test them, and where verification remains incomplete.
---

0 separates a vulnerability hypothesis from runtime evidence. Category-specific
validators execute probes and evaluate observations with ordinary code. These
are distinct from model-based reachability analysis and independent review.
A model's agreement or confidence score does not establish runtime exploitation.

## Current checks

| Category | What the validator observes | Important limits |
|---|---|---|
| Reflected XSS | Chromium captures an alert with an exact, fresh random token. | Requires Playwright and Chromium. GET and form POST probes preserve the real response's CSP. Reflection alone stays unverified; stored and DOM XSS are not comprehensively covered. |
| SQL injection | At least two of response-size differences, delayed responses, and database-error patterns. | These signals can be misleading on unstable or generic error pages; they are not a universal proof of SQL execution. |
| SSRF | A local HTTP collector receives the probe's fresh nonce. | The target must be able to reach the collector. A remote target's loopback is not the scanner's loopback. |
| Command/code injection | A local collector receives a nonce after command-shaped probes. | Callback evidence needs review to distinguish command execution from other URL-fetch behavior; this is not a general RCE harness. |
| Path traversal | A traversal response contains a passwd-like signature. | Static text can resemble that signature. A controlled, unpredictable file marker is stronger evidence and is not yet this oracle's default. |
| ID/resource mutation | Different bodies are returned for adjacent numeric IDs. | Kept as an unverified candidate. Proving IDOR requires an identity and resource-ownership boundary. |

These checks use the finding's recorded request and the scan target. The
agentic web scan runs category checks during verification. Its save-finding
hook can also return inline validator feedback for high and critical findings.
The standalone category dispatcher is not automatically run for every static
review, chat message, or CLI command.

## Interpreting results

A successful XSS execution check is stronger than HTML reflection. Likewise,
source analysis, an HTTP 200, changed response text, or a zero command exit
code must not automatically become an exploit claim.

Keep hypotheses that have not reproduced for follow-up. An unavailable browser,
unreachable collector, missing authentication, or broken fixture means the
validator could not establish the result; it does not prove the application is
safe. Report consumers should inspect evidence and distinguish candidates from
reproduced findings. Current aggregate scan reports can include both.

The category oracle result (`verified`, `confidence`, `evidence`, `reason`) is
not the standalone replay JSON contract. See [Verification Results](../verification-result/)
for replay status, assertions, retained artifacts, and `0 verify` commands.

## Run the real browser qualification

From a source checkout with dependencies and Playwright Chromium installed:

```bash
ZERO_TEST_BROWSER_ORACLES=1 pnpm --filter @0/core exec vitest run \
  src/triage/oracles.browser.test.ts src/triage/oracles.test.ts
```

The browser suite starts loopback-only fixture endpoints and uses the actual
inline validator and Chromium. It confirms vulnerable GET and POST endpoints,
rejects escaped, CSP-blocked and JSON reflection and unrelated alerts, and
keeps differing public resources unverified. No live third-party target or model
provider is needed. Without the environment flag the optional browser suite is
skipped; when explicitly requested, a missing browser must fail qualification.

## Deployment limits

Run probes only in the approved environment. The category oracle's direct HTTP
transport is not yet a complete scope-enforcement boundary: evidence URLs,
redirects, response sizes and total execution budgets need further hardening.
The request parser does not restore original authentication headers or cookies;
authenticated reproduction requires additional integration and qualification.
Do not infer isolation or target authorization from a validator result.

The separate runtime-verifier stage still has a placeholder provisioning driver;
it does not automatically boot an arbitrary repository into a working target.
Nor does this qualification establish end-to-end SmolVM or private Azure/AWS
deployment. Those require separate environment tests.
