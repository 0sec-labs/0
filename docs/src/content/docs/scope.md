---
title: Scope & Authorization
description: Define CLI scope JSON, understand hostname and CIDR matching, apply engagement posture controls and evidence, and distinguish target authorization from execution isolation.
---

Scope authorization is an optional first-party plugin, **disabled by default**.
Activate it per project with `0 plugin enable scope`; deactivate it with
`0 plugin disable scope`. A scope file supplies policy but never activates
checks by itself. When disabled, engagement host/path checks, exclusions and
local filesystem authorization boundaries are **not enforced**.

The behavior below describes the enabled plugin. A scope policy limits target
destinations; it does not authorize testing a system and is not an OS sandbox.
Obtain authorization first, then encode allowed hosts and exclusions narrowly.
Credential protection, sandboxing and resource limits remain active regardless
of the scope plugin's state.

## Minimal scope file

Save this as `scope.json`, replacing the example host with your authorized target:

```json
{
  "in_scope": ["app.example.com"],
  "out_of_scope": []
}
```

Then pass the file explicitly:

```bash
0 plugin enable scope
0 scan web --target https://app.example.com --mode web \
  --scope ./scope.json --depth quick --cost-ceiling 2
```

With the plugin enabled, ordinary `scan` refuses live HTTP, HTTPS, and MCP
targets without a scope policy. It checks the initial target against the file.
Missing files or malformed policies remain configuration errors in either state;
an out-of-scope target stops the assessment only when authorization is enabled.

The engine-oriented `http_audit` mode can construct an in-memory policy from
operator-provided target configuration instead. It is not a way to bypass
authorization; see [Configuration](/configuration/).

## Rule matching

Rules match the URL's **hostname** (case-insensitive), not port, path, or
DNS-resolved address.

| Rule | Matches | Does not match |
| --- | --- | --- |
| `app.example.com` | `https://app.example.com/`, including other paths and ports on that hostname | `api.app.example.com` or `example.com` |
| `*.example.com` | `app.example.com` and `a.b.example.com` | The apex `example.com`, or `example.com.attacker.test` |
| `192.0.2.0/24` | A literal IPv4 URL host in that range, such as `http://192.0.2.10/` | A DNS name that happens to resolve into that range |

Use separate rules if both the apex and its subdomains are authorized. Only a
leading `*.` wildcard is supported; a bare `*`, interior wildcard, or IPv6 CIDR
is not supported. IPv4 prefix lengths must be integers from `0` through `32`.
Avoid broad CIDRs unless the whole range is explicitly authorized.

Do not put `https://`, a path, or `:443` into an exact-host rule. Use the hostname
alone. An exact-host rule allows matching on any path/port; it cannot express a
path-only or port-only authorization boundary. If you need those constraints,
agree on a workflow that enforces them rather than encoding them as host rules.

DNS root dots are normalized (`app.example.com.` equals `app.example.com`).
Exact IPv6 address rules are supported and normalized across bare/bracketed
forms; that does **not** add IPv6 CIDR support.

## Exclusions win

A matching `out_of_scope` rule always wins over `in_scope`. An empty allowlist
denies all destinations.

```json
{
  "in_scope": ["example.com", "*.example.com"],
  "out_of_scope": ["payments.example.com", "*.production.example.com"]
}
```

With this policy:

- `https://app.example.com/` is allowed.
- `https://payments.example.com/` is denied.
- `https://api.production.example.com/` is denied.
- `https://production.example.com/` is **allowed**: the exclusion wildcard does
  not match its apex. Add `production.example.com` to the denylist if needed.

Review wildcard boundaries carefully before execution. A redirect or linked
third-party hostname is not made in-scope because the starting page was allowed.

## Scope, credentials, and engagement controls

Scope, credentials, and engagement controls are separate inputs:

| Control | Purpose |
| --- | --- |
| `--scope` | Destination policy; enforced only after `0 plugin enable scope`. |
| `--auth` | Credentials for the target, not permission to test it. |
| Model credential / `--model` | Which model handles the investigation. |
| `--engagement-profile conservative` | A quieter testing posture, not a new scope. |
| `--rate-limit` | Request pacing, not a coverage or isolation guarantee. |
| `--cost-ceiling` | Model-spend limit for the run, not a managed engagement quote. |

[Engagement controls](#engagement-posture-profile) cover attribution, rate/jitter controls,
and WAF behavior. With the scope plugin enabled, generic scanner commands are
suppressed on scoped scan paths by default. `--allow-scanners` relaxes that
policy without expanding host authorization. Structured scanner tools retain
their explicit scanner opt-in regardless of scope activation.

### Requirements differ by command

| Entry point | Authorization while the scope plugin is enabled |
| --- | --- |
| `scan` with HTTP(S)/MCP | Requires a matching engagement policy before starting, including localhost. |
| `recon --active` / `js-recon` / `cloud` / `agent-assure` | Require `--scope`; existing candidate/endpoint checks apply before live work. |
| `recon` without `--active` | Still performs CT/DNS lookups and HTTP probes. Its scope option is not a universal guard over those paths. |
| `identity` | Supplied scope must allow `graph.microsoft.com`. Token delivery remains pinned to the configured Graph origin even with the plugin disabled. |
| `adgraph` / `entragraph` | Analyze supplied exports offline; do not collect or authorize access to a directory. |
| `scan source`, `fix`, `scan repair` | Source/tool execution boundaries, not live-target scope-file enforcement. `fix` and `scan repair` do not accept `--scope`. |

In particular, `recon --scope` is currently forwarded only to active subdomain
enumeration, not to passive discovery, HTTP spec/MCP probes, or their redirects.
If an engagement requires a hard destination boundary for all traffic, enforce
it outside the process before running recon. Do not assume `scan`'s refusal
contract applies to every command.

## Local workflows and strict scope mode

Local source and package workflows do not activate scope-dependent shell
egress guards when run without a policy. The `scope_guards_inert` diagnostic
identifies that condition; other tool
restrictions may still apply. Local code acquisition, model requests, and tools
can require network access.

Chat's YOLO mode distinguishes public repository checkout
from live-target authorization. A standalone HTTPS `git clone` can acquire
source without adding the hosting service to the engagement scope. Explicit
host/address exclusions apply only while the scope plugin is enabled; private-network restrictions always remain. Other
commands do not inherit that checkout permission. See
[public repository acquisition](/console/#acquiring-public-source).

`ZERO_REQUIRE_SCOPE=1` and `scan --require-scope` make the **enabled** plugin
fail closed in unscoped local modes too. Neither activates the plugin or creates
a policy. Use `0 plugin enable scope` first; check the command-specific
[reference](/commands/) rather than adding unsupported flags.

## Execution boundary

The default shell executor runs on your host. URL checks and scanner
suppression are not a firewall, namespace, container, or VM boundary. Use a
disposable environment for untrusted code and targets. Docker and verifier
paths have separate prerequisites in [Configuration](/configuration/) and
[Scans](/scans/).

Confirm the target, scope, credentials, and allowed side effects are still
valid before resuming. Persisted state is not continuing authorization.

For `scan repair`, setup commands, regression tests, and generated behavioral probes
run in disposable checkouts **inside the current engine**. They can access that
worker's network and credentials; `--publish` additionally authorizes the
workflow to attempt GitHub branch/PR writes. Passing a state directory does
not provision isolation. See
[repository lifecycle](/scans/#repository-lifecycle-with-scan-repair).

## Diagnose a scope refusal

1. Check that `--scope` points to the intended file in the current execution
   environment. A host path is not automatically present inside Docker.
2. Confirm valid JSON and string arrays for `in_scope` / `out_of_scope`.
3. Compare the target hostname with the matching rules, including apex versus
   wildcard and exclusions.
4. Check whether redirects, API calls, or tool arguments target another host.
5. Correct an accidental mismatch or obtain additional authorization. Do not
   widen the allowlist just to silence the refusal.

Source: `packages/engine/src/scope/scope.ts`,
`packages/engine/src/scope/scope-guard.ts`, and
`packages/cli/src/commands/scan.ts`.

<span id="authorized-engagements"></span>
## Authorized engagements

Use 0 only for authorized testing. Agree on destinations, credentials, testing
windows, traffic attribution, allowed side effects, and evidence handling before
running it. Attribution and declared-scope controls help identify and constrain
supported traffic paths; they are not proof of authorization or a network
sandbox. This page covers posture controls and engagement evidence.

## Engagement posture profile

The standard scan posture uses a 5 rps/host fallback, no jitter, and permits
adaptive WAF-evasion escalation. `--engagement-profile conservative` selects a
quieter posture; it does not qualify a target as safe for production testing:

```bash
0 scan web --target https://app.example.com --mode web \
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
0 scan web --target https://app.example.com --scope ./engagement-scope.json --no-waf-evasion
# or
env ZERO_WAF_EVASION=0 0 scan web --target https://app.example.com --scope ./engagement-scope.json
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

`0 runs timeline` builds a chronological record from the pipeline-event audit
trail. It uses the selected SQLite database (not all run-local databases).
Pass `--db-path` for the inspected run:

```bash
0 runs timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db
0 runs timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db --format json
0 runs timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db --format csv
0 runs timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db --attack-only
0 runs timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db \
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

`0 research identity` assesses an Entra ID tenant through Microsoft Graph: privileged
roles, conditional access, app registrations, service principals, and federation.
The Graph client structurally hard-codes `GET`; this is read-only collection,
not credential testing, directory exploitation, or an offline command.

Save a separate scope file allowing `graph.microsoft.com`, and supply a Graph
directory-read token via the `ZERO_GRAPH_ACCESS_TOKEN` environment variable from
your approved credential mechanism. It is not accepted as a CLI argument.

```bash
0 research identity --tenant 00000000-0000-0000-0000-000000000000 \
  --scope ./graph-scope.json --timeout 300000 --json > identity-result.json
```

Replace the tenant ID with the authorized tenant. The CLI compares it with the
tenant read from `/organization` **after collection**; the token determines the
directory actually queried. If `/organization` is unavailable, the CLI warns
that it could not confirm the tenant. Inspect snapshot counts and warnings:
zero collected objects, a confirmed tenant mismatch, or a timeout exits `2`;
partial collection warnings are not a clean-tenant verdict.

Offline JWT/SAML analysis is a separate **library API**
(`analyzeToken`, `analyzeJwt`, `analyzeSamlAssertion` from `@0/engine`), not an
automatic part of `0 research identity`. It checks operator-supplied material without
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

**Active Directory** — `0 research adgraph --input <path>` computes attack paths from a
BloodHound CE / SharpHound export: paths to Domain Admin, kerberoastable
principals, unconstrained delegation, DCSync rights, ACL abuse, and the ADCS
escalation set (ESC1, ESC3–ESC7, ESC9, ESC10, ESC13). ~60 edge kinds each carry
a written abuse technique.

**Entra ID** — `0 research entragraph --input <path>` does the equivalent over an
AzureHound export: paths to Global Administrator, service-principal escalation,
consent-grant escalation, owner-chain abuse, and guest escalation.

```bash
0 research entragraph --input ./azurehound-export/
0 research entragraph --input ./azurehound-export/ --json
0 research entragraph --input ./export --owned <objectId>,<objectId>   # start from known-compromised principals
0 research entragraph --input ./export --max-depth 4
```

:::caution
An AzureHound run without membership or ownership collections cannot produce
those paths; `entragraph` says so explicitly rather than presenting an empty
result as a clean tenant. AzureHound exports also carry no conditional-access,
federation, or PIM data — run `0 research identity` against a live tenant for those.
:::

<span id="what-0-does-not-do"></span>
## Limitations

- Domain recon starts from supplied domains; it is not an org-name-driven
  inventory or a general CIDR sweep. Even default recon performs DNS and HTTP
  activity. Its scope handling differs from scan; see [requirements by command](#requirements-differ-by-command).
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
finding, while `scan repair` investigates and replays candidate repairs in disposable
checkouts. Neither deploys a fix. See [Scans](/scans/).

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
