---
title: Scan web and APIs
description: Run an authorized assessment against a live web app, API or MCP endpoint.
---

`0 scan web` sends agents at a live target. They map it, attack it, then try to confirm each candidate in a separate verification pass.

```bash
0 scan web --target https://staging.example.com --depth quick --cost-ceiling 5
```

Test only systems you own or are authorized to assess. You need a connected model ([Models and keys](/models/)).

## Authorize the target

Scope enforcement is a built-in plugin, off by default. Turn it on per project so every live scan must name its allowed hosts:

```bash
0 plugin enable scope
cat > scope.json <<'EOF'
{ "in_scope": ["staging.example.com"], "out_of_scope": [] }
EOF
0 scan web --target https://staging.example.com --scope ./scope.json
```

With the plugin on, HTTP, HTTPS and MCP targets (including localhost) are refused without a scope file, and a target outside it is refused before any request. Rules match hostnames, not paths or ports. `out_of_scope` always wins. See [Scope and authorization](/scope/).

Scope is an application policy. It is not a network sandbox.

## Targets

| Target | Command |
|---|---|
| Web app | `0 scan web --target https://app.example.com` |
| REST API with a spec | `0 scan web --target https://api.example.com --api-spec ./openapi.yaml` |
| MCP endpoint | `0 scan web --target mcp://mcp.example.com` |
| Short form | `0 scan https://app.example.com` |

The mode follows the target: `mcp://` runs the MCP assessment, `http(s)://` runs the web assessment. `--mode probe|deep|mcp|web|http_audit` overrides it. `--api-spec` accepts OpenAPI 3.x or Swagger 2.0 and seeds endpoints, parameters and auth requirements.

In an interactive terminal, `scan web` first asks you to confirm a plan. Pass `--no-guided` to skip it and use only the flags you gave.

## Authenticate to the target

`--auth` takes a JSON object or a path to a file with one. Prefer a file so the secret stays out of shell history.

```bash
cat > auth.json <<'EOF'
{"type":"bearer","token":"your-target-token"}
EOF
0 scan web --target https://api.example.com --api-spec ./openapi.yaml --auth ./auth.json
```

Other shapes:

```json
{"type":"cookie","value":"session=your-session-cookie"}
{"type":"basic","username":"test-user","password":"your-test-password"}
{"type":"header","name":"X-API-Key","value":"your-target-api-key"}
```

Your model key pays for inference. Target credentials only authenticate to the target.

### Test access control with several users

```bash
0 scan web --target https://app.example.com --identities ./identities.json \
  --access-control-fixtures ./fixtures.json
```

`--identities` replaces `--auth`. The file holds 2 to 16 entries, each `{ "label", "role", "auth" }`, with unique labels and the same `auth` shapes as above. `--access-control-fixtures` lists resources with a known owner, so the verifier can replay a cross-user read. Similar response bodies alone do not prove an IDOR.

<span id="white-box"></span>
## Add source code (white box)

```bash
0 scan web --target http://localhost:8080 --repo ./my-app
```

`--repo` gives the agents the source behind the URL. They get `read_file` and `run_command` on that directory, and the prompt asks them to map routes to handlers and follow input to sinks before attacking. This finds hardcoded credentials, missing role checks and unlinked admin routes that HTTP probing misses.

`--repo` is a local directory. 0 does not clone it, start the app or check that it matches the deployed revision. Source observations are leads until a live request confirms them. For source-only review, use [`0 scan source`](/scan-code/).

## Depth, cost and traffic

```bash
0 scan web --target https://staging.example.com \
  --depth quick --cost-ceiling 5 --rate-limit 2 --engagement-profile conservative
```

| Option | Default | What it does |
|---|---|---|
| `--depth quick\|default\|deep` | `default` | Investigation budget, not a deadline |
| `--cost-ceiling <usd>` | none | Stop when estimated spend passes this. In-flight calls can overshoot. Partial findings are kept. |
| `--timeout <ms>` | `30000` | Per-request timeout. Also the scan deadline unless a confirmed plan sets its own time cap. |
| `--rate-limit <spec>` | `5` rps per host | For example `2` or `host=5,*=3` |
| `--engagement-profile` | `standard` | `conservative` caps traffic at 1 rps per host, adds jitter and turns off WAF evasion |
| `--no-waf-evasion` | evasion on | Disable adaptive retries with mutated encodings |
| `--allow-scanners` | off | Let the agent use generic scanners such as `wpscan` in scope-enforced scans. Keep it off unless the program allows them. |
| `--attribution-header <name=value>` | none | Header sent on in-scope requests only. Repeatable. |
| `--attribution-ua <token>` | none | Token added to the User-Agent on in-scope requests |

See [Costs and budgets](/budgets/) for how spend is tracked.

### WordPress

WordPress fingerprinting is on by default. When the agent finds WordPress, it lists plugins and themes, reads their versions and looks up known CVEs. Set `WPSCAN_API_TOKEN` to add WPScan data. Disable it with `ZERO_FEATURE_WP_FINGERPRINT=0`.

### Long-running campaigns

```bash
0 scan campaign --target https://staging.example.com --scope ./scope.json --iterations 3
```

A campaign runs several objective-driven missions in a row, each visible in the browser app. `--scope` is required because the missions run without per-action approval. `--dry-run` prints the plan without starting anything. Run `0 scan campaign --help` for time and cost caps.

## What you get

The terminal prints each finding with its severity, the request and response that support it, and the agent's analysis. Use `--format json` for the full report, or `sarif`, `md`, `html` or `pdf` ([Reports](/reports/)).

```bash
0 scan web --target https://staging.example.com --format json > scan.json
```

Each run is stored in `~/.0/runs/<scan-id>/state.db` with `report.json`. Pick another database with `--db-path`. Review results under **Findings** in the browser app or with [`0 findings`](/findings/).

Exit codes: `0` completed with no high or critical findings, `1` at least one high or critical finding, `2` error, `4` stopped at the cost ceiling. `scan web` has no static-only layer: without a model it fails.

### Resume and replay

```bash
0 scan web --target https://staging.example.com --scope ./scope.json --resume SCAN_ID
0 runs relaunch SCAN_ID
0 runs replay --scan SCAN_ID
```

`--resume` continues a run from its on-disk journal and lets you supply scope and credentials again. `0 runs relaunch` resumes from persisted state without them. `0 runs replay` prints the stored attack chain; it sends no traffic and does not re-verify anything.

## Run in a container

```bash
mkdir -p scan-output
docker run --rm \
  -v "$PWD/scope.json:/work/scope.json:ro" \
  -v "$PWD/scan-output:/output" -e ANTHROPIC_API_KEY -e ZERO_RUN_DIR=/output \
  --entrypoint /bin/sh ghcr.io/0sec-labs/0:latest -c \
  '0 plugin enable scope && exec 0 scan web --target https://app.example.com \
  --scope /work/scope.json --runtime api --depth quick --cost-ceiling 2 --format json'
```

The image runs as user `ubuntu` (UID 1000) in `/work`. `ZERO_RUN_DIR` puts `state.db` and `report.json` in the mounted directory. Plugin approval on the host does not carry into the container, so enable scope inside it. See [Docker](/docker/).

## Limits

- A clean run does not prove the target is secure. Depth, budget, model, auth and the paths the agents reached all bound coverage.
- Verification is a fresh agent pass per finding. Read the evidence; a `confirmed` label is not a deterministic replay. For that, use [`0 verify`](/verify-and-fix/).
- `--dry-run` on `--emit pr` only stops PR creation. The scan still runs and spends.
- Scans send real traffic. A deadline requests cancellation; in-flight work can run past it.
