---
title: Scope & Authorization
description: Define CLI scope JSON, understand hostname and CIDR matching, and distinguish target authorization from execution isolation.
---

A scope policy limits target destinations. It does not authorize testing a
system and is not an OS sandbox. Obtain authorization first, then encode
allowed hosts and exclusions as narrowly as possible.

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
0 scan --target https://app.example.com --mode web \
  --scope ./scope.json --depth quick --cost-ceiling 2
```

The ordinary `scan` path refuses live HTTP, HTTPS, and MCP targets without a
scope policy. It also checks that the initial target matches the supplied file.
Missing files, malformed policies, and an out-of-scope initial target stop the
scan with exit code `2` before the assessment starts.

The worker-oriented `http_audit` mode can construct an in-memory policy from
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
| `--scope` | Authorized destination allow/deny rules. |
| `--auth` | Credentials for the target, not permission to test it. |
| Model credential / `--model` | Which model handles the investigation. |
| `--engagement-profile conservative` | A quieter testing posture, not a new scope. |
| `--rate-limit` | Request pacing, not a coverage or isolation guarantee. |
| `--cost-ceiling` | Model-spend limit for the run, not a managed engagement quote. |

[Authorized Engagements](/engagements/) covers attribution, rate/jitter controls,
and WAF behavior. Generic scanner tools are suppressed on scoped scan paths by
default. `--allow-scanners` relaxes that particular gate; use it only with explicit
permission for the additional traffic. It does not expand the host allowlist.

### Requirements differ by command

| Entry point | Current authorization control |
| --- | --- |
| `scan` with HTTP(S)/MCP | Requires a matching engagement policy before starting, including localhost. |
| `recon --active` | Requires `--scope`; checks active DNS brute-force candidates before resolving them. |
| `recon` without `--active` | Still performs CT/DNS lookups and HTTP probes. Its scope option is not a universal guard over those paths. |
| `identity` | Scope is optional; when supplied it must allow `graph.microsoft.com`. The Graph token determines the actual tenant queried. |
| `adgraph` / `entragraph` | Analyze supplied exports offline; do not collect or authorize access to a directory. |
| `review`, `fix`, `secure` | Source/tool execution boundaries, not live-target scope-file enforcement. `fix` and `secure` do not accept `--scope`. |

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

The interactive console's YOLO mode distinguishes public repository checkout
from live-target authorization. A standalone HTTPS `git clone` can acquire
source without adding the hosting service to the engagement scope. Explicit
host/address exclusions and private-network restrictions still apply; other
commands do not inherit that checkout permission. See
[public repository acquisition](/console/#acquiring-a-public-repository-in-yolo).

`ZERO_REQUIRE_SCOPE=1` requests fail-closed behavior where these guards are
used. It does not manufacture a policy, and not every command accepts `--scope`.
Use the command-specific [reference](/commands/) instead of adding unsupported
flags. The `scan --require-scope` option is not needed to activate the normal
live-target scope requirement.

## Execution boundary

The default shell executor runs on your host. URL checks and scanner
suppression are not a firewall, namespace, container, or VM boundary. Use a
disposable environment for untrusted code and targets. Docker and verifier
paths have separate prerequisites in [Configuration](/configuration/) and
[Scan Workflows](/scan-workflows/).

Confirm the target, scope, credentials, and allowed side effects are still
valid before resuming. Persisted state is not continuing authorization.

For `secure`, setup commands, regression tests, and generated behavioral probes
run in disposable checkouts **inside the current worker**. They can access that
worker's network and credentials; `--publish` additionally authorizes the
workflow to attempt GitHub branch/PR writes. Neither selecting hosted model
transport nor passing a state directory provisions isolation. See
[repository lifecycle](/scan-workflows/#repository-lifecycle-with-secure).

## Diagnose a scope refusal

1. Check that `--scope` points to the intended file in the current execution
   environment. A host path is not automatically present inside Docker.
2. Confirm valid JSON and string arrays for `in_scope` / `out_of_scope`.
3. Compare the target hostname with the matching rules, including apex versus
   wildcard and exclusions.
4. Check whether redirects, API calls, or tool arguments target another host.
5. Correct an accidental mismatch or obtain additional authorization. Do not
   widen the allowlist just to silence the refusal.

Source: `packages/core/src/scope/scope.ts`,
`packages/core/src/scope/scope-guard.ts`, and
`packages/cli/src/commands/scan.ts`.

Managed access follows the separate [0cloud deployment policy](/roadmap/#0cloud).
