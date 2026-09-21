---
title: Authorized Engagements
description: Running 0 inside a client engagement — conservative posture, forensic timelines, and ATT&CK/ATLAS-mapped evidence.
---

Use 0 only for authorized testing. Agree on destinations, credentials, testing
windows, traffic attribution, allowed side effects, and evidence handling before
running it. Attribution and declared-scope controls help identify and constrain
supported traffic paths; they are not proof of authorization or a network
sandbox. This page covers posture controls and engagement evidence.

## Engagement profile

The standard scan posture uses a 5 rps/host fallback, no jitter, and permits
adaptive WAF-evasion escalation. `--engagement-profile conservative` selects a
quieter posture; it does not qualify a target as safe for production testing:

```bash
0 scan --target https://app.example.com --mode web \
  --scope ./engagement-scope.json \
  --engagement-profile conservative
```

| Behaviour | Default | Conservative |
|---|---|---|
| Request rate | 5 rps/host | 1 rps/host |
| Jitter | none | full, 0–750 ms |
| Reset-endpoint burst probe | 15 POSTs | disabled (converted to a manual-test lead) |
| Web-recon pre-pass | unthrottled | routed through the rate limiter |
| WAF-evasion ladder | auto-fires on block | disabled |

Jitter is paced on the non-blocking path too.

**Profile-field precedence:** scope file > environment > CLI flag. The
conservative profile lowers the scan's fallback request rate; it is **not a
hard ceiling over an explicit `scan --rate-limit` value**. Review both the
profile and rate specification before executing an engagement. The MCP server
uses a stricter clamp over its rate specification; do not assume those two
entry points resolve rates identically.

Disable the WAF-evasion ladder independently to stop automatic escalation into
encoding-mutated payloads (detection and block reporting are unaffected):

```bash
0 scan --target https://app.example.com --scope ./engagement-scope.json --no-waf-evasion
# or
env ZERO_WAF_EVASION=0 0 scan --target https://app.example.com --scope ./engagement-scope.json
```

Env vars: `ZERO_ENGAGEMENT_PROFILE`, `ZERO_WAF_EVASION`,
`ZERO_ENGAGEMENT_RATE_RPS`, `ZERO_ENGAGEMENT_JITTER_MS`. The corresponding
scope-file fields use snake case:

```json
{
  "in_scope": ["app.example.com"],
  "out_of_scope": [],
  "engagement": {
    "profile": "conservative",
    "waf_evasion": false,
    "reset_burst_probe": false,
    "rate_limit_rps": 1,
    "jitter_ms": 750
  }
}
```

Use the applied record to inspect overrides rather than assuming the profile
name alone captures every control. These settings cover supported engine paths,
not arbitrary subprocess or extension traffic.

When a profile is active the report carries an `engagementPosture` record and
emits an `engagement_posture_applied` event. It records the posture **as
applied** (resolving env overrides), which is what a client asks for after the
fact. Runs without a profile are unchanged.

## Forensic timeline

`0 timeline` builds a chronological record from the pipeline-event audit
trail. It uses the selected SQLite database (not all run-local databases).
Pass `--db-path` for the inspected run:

```bash
0 timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db
0 timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db --format json
0 timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db --format csv
0 timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db --attack-only
0 timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db \
  --since 2026-09-01T09:00:00Z --until 2026-09-01T17:00:00Z
```

Rows carry UTC ISO-8601 timestamps, stage, event type, an action summary, and
technique mappings; agent role appears when recorded. `--attack-only` reports
filtered and total counts, so a filtered record states what it omitted.

Instrumented tool invocations can include start time, duration, outcome, and
redacted arguments (redacted before truncation). Where an event supplies a
`correlationId`, follow it to retained request artifacts for URL/method/status
detail. The timeline is a view of recorded pipeline events, not a packet capture
or a guarantee that every subprocess request has its own row.

## Technique mapping — two matrices

Findings and actions map against **two** MITRE matrices:

- **ATT&CK (Enterprise)** — SQLi, SSRF, command injection, memory-safety,
  credential access.
- **ATLAS (AI systems)** — prompt injection, jailbreak, system-prompt
  extraction, multi-turn manipulation.

A row may carry either, both, or neither. A behaviour with no match is left
empty.

:::note
The current ATT&CK Enterprise matrix renamed tactic **TA0005** "Defense Evasion"
to "Stealth" and **T1211** to "Exploitation for Stealth". 0 uses the current
names; if a client's tooling is pinned to an older release, remap at the
presentation layer.
:::

## Identity and token analysis

`0 identity` assesses an Entra ID tenant through Microsoft Graph: privileged
roles, conditional access, app registrations, service principals, and federation.
The Graph client structurally hard-codes `GET`; this is read-only collection,
not credential testing, directory exploitation, or an offline command.

Save a separate scope file allowing `graph.microsoft.com`, and supply a Graph
directory-read token via the `ZERO_GRAPH_ACCESS_TOKEN` environment variable from
your approved credential mechanism. It is not accepted as a CLI argument.

```bash
0 identity --tenant 00000000-0000-0000-0000-000000000000 \
  --scope ./graph-scope.json --timeout 300000 --json > identity-result.json
```

Replace the tenant ID with the authorized tenant. The CLI compares it with the
tenant read from `/organization` **after collection**; the token determines the
directory actually queried. If `/organization` is unavailable, the CLI warns
that it could not confirm the tenant. Inspect snapshot counts and warnings:
zero collected objects, a confirmed tenant mismatch, or a timeout exits `2`;
partial collection warnings are not a clean-tenant verdict.

Offline JWT/SAML analysis is a separate **library API**
(`analyzeToken`, `analyzeJwt`, `analyzeSamlAssertion` from `@0/core`), not an
automatic part of `0 identity`. It checks operator-supplied material without
network calls, including:

- **JWT** — `alg:none`, algorithm confusion, unsafe `kid`/`jku`/`x5u`/`jwk`,
  missing/excessive expiry, weak audience, no replay controls, sensitive claims,
  broad scope.
- **Entra** — access-vs-ID token misuse, weak client binding, privileged `wids`,
  multi-tenant issuer, long-lived session indicators (PRT, CAE).
- **SAML** — XML Signature Wrapping, unsigned assertions, weak conditions,
  missing audience restriction, NameID comment truncation, Golden SAML
  preconditions.

The token-analysis findings use a SHA-256 fingerprint and redacted preview
instead of raw token material. This does not remove the need to protect input
tokens, directory exports, and output metadata.

:::caution
Identity findings name the affected principal, including user principal names.
Treat finding output as personal data under applicable data-protection
obligations.
:::

## Attack paths — on-prem and cloud

Two commands, same shape. The client's collector runs wherever the engagement
puts it; analysis runs here. Both are offline — no collection, auth, or network.

**Active Directory** — `0 adgraph --input <path>` computes attack paths from a
BloodHound CE / SharpHound export: paths to Domain Admin, kerberoastable
principals, unconstrained delegation, DCSync rights, ACL abuse, and the ADCS
escalation set (ESC1, ESC3–ESC7, ESC9, ESC10, ESC13). ~60 edge kinds each carry
a written abuse technique.

**Entra ID** — `0 entragraph --input <path>` does the equivalent over an
AzureHound export: paths to Global Administrator, service-principal escalation,
consent-grant escalation, owner-chain abuse, and guest escalation.

```bash
0 entragraph --input ./azurehound-export/
0 entragraph --input ./azurehound-export/ --json
0 entragraph --input ./export --owned <objectId>,<objectId>   # start from known-compromised principals
0 entragraph --input ./export --max-depth 4
```

:::caution
An AzureHound run without membership or ownership collections cannot produce
those paths; `entragraph` says so explicitly rather than presenting an empty
result as a clean tenant. AzureHound exports also carry no conditional-access,
federation, or PIM data — run `0 identity` against a live tenant for those.
:::

<span id="what-0sec-does-not-do"></span>
## Limitations

- Domain recon starts from supplied domains; it is not an org-name-driven
  inventory or a general CIDR sweep. Even default recon performs DNS and HTTP
  activity. Its scope handling differs from scan; see [Scope](/scope/#requirements-differ-by-command).
- Identity posture collection and offline AD/Entra graph paths do not execute
  SMB/RDP/LDAP exploitation, credential spraying, or the reported privilege paths.
- A quiet posture does not imply stealth or universal detection-evasion
  prevention: standard scans have a WAF-evasion ladder, and effectful shell
  tools are not a network sandbox.
- Runtime, OS, and kernel research are separate workflows with execution/VM
  prerequisites, not automatic stages of a web engagement.
- Do not authorize persistence, implants, C2, pivoting, or destructive impact
  merely by providing a hostname scope.

Agree on a bounded demonstration and stop condition for each finding. A saved
lead or model confirmation is not always a proven vulnerability; inspect the
actual verifier result before disclosure. `fix` repairs one reproduced source
finding, while `secure` investigates and replays candidate repairs in disposable
checkouts. Neither deploys a fix. See [Scan Workflows](/scan-workflows/).

## Data residency

To keep model-bound data inside a defined perimeter, configure the selected
provider endpoint and audit all role/model overrides. Azure OpenAI is supported:

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://<resource>.openai.azure.com
export AZURE_OPENAI_MODEL=<deployment-name>
```

When Azure is selected, the runtime makes a best-effort `x-ms-region` probe and
records the result in provider diagnostics; failures can produce `unknown`.
The header is diagnostic evidence, not a residency attestation.

1. Merely setting Azure variables does not prove all model traffic uses Azure:
   provider precedence, explicit model selection, per-role routing, and optional
   assistance can select other transports. Verify the effective configuration.
2. Other enrichment paths still egress — GitHub API, OSV, package registries,
   Microsoft Graph, OAST. Network containment is separate.
3. Pin `--runtime api` when relying on API-provider configuration. The `claude`,
   `codex`, and `gemini` runtimes shell out to third-party binaries whose egress
   0 does not control.
4. Jev features are separately opt-in with `ZERO_JEV_FEATURES`; enabling one
   consents to sending its advisory input to the configured evaluator. Keep
   them disabled unless that transport is permitted by the engagement.

See [API Keys](/api-keys/) for the full provider matrix.
