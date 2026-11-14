---
title: Costs and budgets
description: Cost ceilings, turn limits and price estimates for 0 runs.
---

0 has three separate limits: estimated model cost, agent turns and request timeouts. The software is free. Provider, subscription and infrastructure costs still apply.

## Set a cost ceiling

```bash
0 scan source ./authorized-repo --runtime api --cost-ceiling 5
0 scan package lodash --runtime api --cost-ceiling 2
env ZERO_COST_CEILING_USD=3 0 scan web --target https://authorized.example --scope ./scope.json --runtime api
```

`--cost-ceiling <usd>` beats `ZERO_COST_CEILING_USD`. The value must be positive. With neither, there is no dollar limit.

When the estimate passes the ceiling, 0 stops, keeps partial findings and exits with code `4`. With `ZERO_EMIT_RESULT_LINE=1` the result line carries `exit_reason: "cost_ceiling_exceeded"`. Treat a cost stop as incomplete, not as a clean result.

Commands that take `--cost-ceiling`: `scan web`, `scan source`, `scan package`, `scan deep`, `scan campaign`, `secure`, `bench` and `ingest`.

Limits:

- It is a soft stop on estimated usage, not an invoice cap. Calls in flight finish, so each active session can overshoot by one turn.
- Source and package scans share one ledger across research, per-file sessions and verification. `scan deep` shares one across its planner and finders.
- `secure --cost-ceiling` is not a whole-workflow cap. The repair loop checks its own ledger between findings, so the shown cost is not a reliable investigation-plus-repair total.
- Tool services, infrastructure and other integrations are not metered by the ledger.

## Turn limits

A turn is one model round trip. It can hold several tool calls.

| Work | Default |
| --- | --- |
| Web and deep scan attack stage | 20 (`quick`), 40 (`default`), 100 (`deep`) |
| Source and package research and verification | No limit. The agent stops when the work is done. |
| Browser app chats | No limit per message. `0 console --max-tool-calls <n>` sets one. |

A larger limit raises the ceiling on work, not the floor. A run that finishes early does not use the rest.

To bound source and package scans, for example in CI:

```bash
env ZERO_MAX_TURNS_REVIEW=30 ZERO_MAX_TURNS_VERIFY=12 \
  0 scan source ./authorized-repo --runtime api --cost-ceiling 5
```

| Variable | Applies to |
| --- | --- |
| `ZERO_MAX_TURNS` | Every shared-runner session |
| `ZERO_MAX_TURNS_AUDIT` | Package audit research (beats the global value) |
| `ZERO_MAX_TURNS_REVIEW` | Source review research (beats the global value) |
| `ZERO_MAX_TURNS_VERIFY` | Verification (beats the global value) |

Invalid, zero or negative values are ignored. These do not limit the web attack stage. MCP, kernel and per-file hunts have their own limits.

Near the end of a session the agent gets two one-time warnings, at 85% of the limit and three turns before it. `ZERO_FEATURE_BUDGET_WARNINGS=0` turns the warnings off. It does not remove the limit.

## When a budget runs out

0 keeps partial findings and records an incomplete session. An exhausted attack stage can still feed verification and reporting. Read the incomplete-run reason before you trust a partial report. Do not assume every saved finding was reproduced.

With a database attached, loops checkpoint every two turns. Resume does not replay requests that were in flight.

## Cost estimates

The estimator prices input, output, cached-input and cache-write tokens from a bundled rate table. An unknown model price is unknown, not zero.

- Gateway prices can differ from direct-provider prices. A matching model name does not mean a matching bill.
- Subscription routes (ChatGPT Codex, coding plans) have their own allowances. Token-dollar estimates do not show remaining quota.
- Failed or cancelled requests can use provider capacity without usage reaching the CLI. Check your provider invoice.

## Choosing a depth

Use `quick` for a short pass, `default` for routine work and `deep` when the target warrants more. Set a dollar ceiling and a provider-side spending limit as separate controls.

A repeated run can take a different path and repeats the spend. A run with no findings does not prove the target is secure.

Provider retry settings are on [Configuration](/configuration/#retries-and-timeouts).
