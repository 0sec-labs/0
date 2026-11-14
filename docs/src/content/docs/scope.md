---
title: Scope and authorization
description: Limit live testing to authorized hosts with a scope file, tune engagement posture, and know what scope does not isolate.
---

A scope file lists the hosts 0 may test. Use one for every live target.

Only test systems you own or are authorized to test. A scope file encodes that authorization; it does not grant it, and it is not a sandbox.

## Set up scope

Scope enforcement is a built-in plugin. It is **off by default**. Turn it on per project:

```bash
0 plugin enable scope
```

Save `scope.json` with your authorized hosts:

```json
{
  "in_scope": ["app.example.com"],
  "out_of_scope": []
}
```

Pass it to the scan:

```bash
0 scan web --target https://app.example.com --scope ./scope.json --depth quick --cost-ceiling 2
```

With the plugin on, `scan` refuses HTTP, HTTPS and MCP targets without a scope file, including localhost. The target is checked before work starts. A missing or malformed file is always an error.

With the plugin off, host checks, exclusions and local filesystem boundaries are **not enforced**. Credential protection, sandboxing and resource limits apply either way. Turn it off with `0 plugin disable scope`.

## Matching rules

Rules match the URL's **hostname**, case-insensitive. Port, path and resolved IP address are ignored.

| Rule | Matches | Does not match |
| --- | --- | --- |
| `app.example.com` | `https://app.example.com/` on any path or port | `api.app.example.com`, `example.com` |
| `*.example.com` | `app.example.com`, `a.b.example.com` | The apex `example.com`, `example.com.attacker.test` |
| `192.0.2.0/24` | A literal IPv4 host in range, such as `http://192.0.2.10/` | A DNS name that resolves into the range |

- Write the hostname alone. No `https://`, path or `:443`.
- Only a leading `*.` wildcard works. No bare `*`, interior wildcards or IPv6 CIDRs.
- Add the apex and `*.` as two rules if both are authorized.
- IPv4 prefix lengths are integers from 0 to 32. Avoid broad ranges unless all of it is authorized.
- Exact IPv6 addresses work in bare or bracketed form.
- A trailing root dot is ignored (`app.example.com.` equals `app.example.com`).

### Exclusions win

A matching `out_of_scope` rule always beats `in_scope`. An empty `in_scope` denies everything.

```json
{
  "in_scope": ["example.com", "*.example.com"],
  "out_of_scope": ["payments.example.com", "*.production.example.com"]
}
```

- `https://app.example.com/` is allowed.
- `https://payments.example.com/` is denied.
- `https://api.production.example.com/` is denied.
- `https://production.example.com/` is **allowed**. The wildcard does not match its apex; add it to `out_of_scope` too.

A redirect or a linked third-party host does not become in scope because the start page was.

## Scope is one input of several

| Input | What it controls |
| --- | --- |
| `--scope` | Which hosts may be reached, once the plugin is on. |
| `--auth` | Credentials for the target. Not permission to test it. |
| `--model` and your provider key | Which model does the work. |
| `--engagement-profile conservative` | A quieter testing posture. Not a new scope. |
| `--rate-limit` | Request pacing. |
| `--cost-ceiling` | Estimated model spend for the run. |

With the plugin on, generic scanner wrappers (sqlmap, nikto and similar) are hidden on scoped scans. `--allow-scanners` shows them without widening the host list.

<span id="requirements-differ-by-command"></span>
### What each command enforces

| Command | With the scope plugin on |
| --- | --- |
| `scan web` (HTTP, HTTPS, MCP) | Needs a matching scope file before it starts. |
| `recon --active`, `js-recon`, `cloud`, `agent-assure` | Need `--scope`; candidates are checked before live work. |
| `recon` without `--active` | Still does CT, DNS and HTTP lookups. `--scope` only guards active subdomain enumeration, not passive discovery or probes. |
| `identity` | The scope must allow `graph.microsoft.com`. |
| `adgraph`, `entragraph` | Offline analysis of exports you supply. No network. |
| `scan source`, `fix`, `scan repair` | Local source and tool boundaries. `fix` and `scan repair` do not take `--scope`. |

If an engagement needs a hard boundary for all traffic, enforce it outside the process, for example with a firewall.

## Local workflows and strict scope mode

Source and package workflows without a scope file do not turn on scope-based shell egress guards. The `scope_guards_inert` diagnostic marks that state. Cloning code, model requests and tools can still use the network.

In YOLO missions, cloning a public HTTPS repository does not add its host to scope. Exclusions apply only while the plugin is on. Private-network restrictions always apply.

To make unscoped local runs fail instead, set `ZERO_REQUIRE_SCOPE=1` or pass `scan --require-scope`. Both need the plugin to be on; neither turns it on.

## Execution boundary

The default shell executor runs on your host. URL checks and scanner suppression are not a firewall, container or VM. Use a disposable environment for untrusted code and targets.

`scan repair` runs setup commands, tests and probes in disposable checkouts **inside the current engine**. They can reach that machine's network and credentials. `--publish` also lets it push a branch and open a pull request.

Saved state is not ongoing authorization. Before you resume a run, confirm the target, scope, credentials and allowed side effects are still valid.

## Diagnose a scope refusal

1. Check that `--scope` points to the right file where 0 runs. A host path is not inside a container unless you mount it.
2. Check the JSON is valid and `in_scope` and `out_of_scope` are string arrays.
3. Compare the target hostname with each rule, including apex versus wildcard and exclusions.
4. Check whether a redirect, API call or tool argument goes to another host.
5. Fix the mismatch or get more authorization. Do not widen scope just to silence the refusal.

<span id="authorized-engagements"></span>
## Authorized scope

Before you start, agree on destinations, credentials, testing windows, traffic attribution, allowed side effects and evidence handling. Attribution and scope controls help constrain supported traffic paths. They are not proof of authorization or a network sandbox.

The browser app's **Scope** page (`/scope`) groups scans and findings into an engagement report.

<span id="engagement-posture-profile"></span>
## Posture profile

The default posture paces at 5 requests per second per host and escalates WAF evasion when blocked. `--engagement-profile conservative` is quieter:

```bash
0 scan web --target https://app.example.com --scope ./engagement-scope.json \
  --engagement-profile conservative
```

| Behavior | Default | Conservative |
| --- | --- | --- |
| Request rate | 5 rps per host | 1 rps per host |
| Jitter | none | 0 to 750 ms |
| Reset-endpoint burst probe | 15 POSTs | off (reported as a manual-test lead) |
| Web recon pre-pass | unthrottled | rate-limited |
| WAF-evasion ladder | on when blocked | off |

The profile lowers the fallback rate. It does **not** cap an explicit `--rate-limit`.

Turn off WAF evasion on its own with `--no-waf-evasion` or `ZERO_WAF_EVASION=0`. Detection and block reporting still work.

Set the same controls in the scope file. The scope file beats environment variables, which beat CLI flags:

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

Environment variables: `ZERO_ENGAGEMENT_PROFILE`, `ZERO_WAF_EVASION`, `ZERO_ENGAGEMENT_RATE_RPS` and `ZERO_ENGAGEMENT_JITTER_MS`. A bad profile name or value stops the scan with exit code 2.

When a profile is active, the report carries an `engagementPosture` record with the posture as applied, and the run emits an `engagement_posture_applied` event. These controls cover 0's own request paths, not arbitrary subprocess or plugin traffic.

## Forensic timeline

`0 runs timeline` builds a chronological record from a run's event log:

```bash
0 runs timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db
0 runs timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db --format csv
0 runs timeline <scanId> --db-path ~/.0/runs/<scanId>/state.db --attack-only \
  --since 2026-09-01T09:00:00Z --until 2026-09-01T17:00:00Z
```

Rows carry UTC timestamps, stage, event type, an action summary and technique mappings. Tool calls can include duration, outcome and redacted arguments. `--attack-only` reports how many rows it filtered out. The timeline shows recorded events. It is not a packet capture.

Findings and actions map to MITRE ATT&CK (Enterprise) and MITRE ATLAS (AI systems). A row can carry either, both or neither. 0 uses current ATT&CK names, for example TA0005 "Stealth" (formerly "Defense Evasion").

## Data residency

To keep model traffic inside a boundary, pin the provider and endpoint, and check every role model. For example, with Azure:

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/v1
env ZERO_SELECTED_PROVIDER=azure ZERO_MODEL=<deployment-name> 0 scan source ./repo --runtime api
```

- Setting Azure variables alone does not prove all traffic uses Azure. Provider priority and role models can pick other routes. See [Models and keys](/models/#how-0-picks-a-provider).
- Other lookups still leave: GitHub API, OSV, package registries, Microsoft Graph and out-of-band testing services.
- The `claude`, `codex` and `gemini` runtimes call third-party CLIs whose network traffic 0 does not control. Use `--runtime api`.

<span id="what-0-does-not-do"></span>
## What scope does not cover

- Recon starts from domains you supply. It is not an organization-wide inventory or a CIDR sweep.
- Identity collection and AD or Entra graph analysis do not exploit, spray credentials or walk the paths they report. See [Specialist research](/research-workflows/).
- A quiet posture is not stealth.
- A hostname in scope does not authorize persistence, implants, C2, pivoting or destructive impact.
- A saved lead or a model's confirmation is not always a proven vulnerability. Check the verifier result before disclosure. See [Verify and fix](/verify-and-fix/).
