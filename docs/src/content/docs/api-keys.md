---
title: API Keys
description: Supported LLM providers, environment variables, credential priority, model routing, and provider failover.
---

The local 0 CLI can use your own provider key or a supported provider
subscription without a 0cloud account. Hosted model access routes inference
through 0cloud; it does not move your local tools into a managed sandbox.
Managed security work has separate authorization, access and billing.

<a id="hosted-inference-draft"></a>
<a id="0sec-hosted-inference-draft"></a>

## Hosted inference

Hosted access is still a development integration, not a public production
signup flow. Use the CLI version and approved service supplied for your test;
follow [Cloud setup](/getting-started/#hosted-models).

The `api` runtime's `hosted` provider uses a scoped organization credential.
The service holds supplier keys and receives model context, including tool
results. Tools execute on your configured local executor.

### Account, models and usage

`0 models --json` returns an array of model IDs, context limits and maximum
output limits: `id`, `contextTokens` and `maxOutputTokens`. It does not print
supplier details, wire protocols or prices. Select an exact ID from this list;
otherwise the hosted runtime selects the first catalog entry.

`0 balance` displays the service's credit account, separately from the
CLI's estimated model cost. It distinguishes:

| Source | What to check |
| --- | --- |
| Free credits | Eligibility, claimable credits, spendable credits, held credits and the reset time. Claimable is not spendable. |
| Subscription | Subscription state and each reported monthly, weekly or five-hour window. These windows overlap; do not add them together. |
| Prepaid | Spendable and held credits, settled deficit, hold shortfall and whether prepaid use is permitted. |
| Admission | Whether the service currently reports the account eligible to make a request, with its reason when unavailable. |

`0 balance --json` returns a validated `credits-v1` account or `null`.
Credit amounts are decimal integer strings in nanocredits, with 1 credit equal
to 1,000,000,000 nanocredits. Missing amounts stay unavailable, never zero.
Unsupported or malformed account data displays **Credit data unavailable**;
this is not evidence that your credentials are invalid or your balance is empty.
Use a compatible CLI and service before attempting a paid request.

Login does not itself claim credits, buy a subscription or authorize prepaid
spending. Availability and enabled purchase options come from the service.
Use only the account controls provided by the approved deployment; the CLI
does not create a checkout or promise that an offer is available.

The usage endpoint returns recent request metadata. There is no top-level
`0 usage` command; the console's `/usage` describes the current chat.

| Endpoint on the selected cloud host | Required token scope | Purpose |
| --- | --- | --- |
| `GET /api/inference/v1/models` | `inference:read` | Model catalog for the selected service |
| `GET /api/inference/account` | `billing:read` | Versioned credit account and admission state |
| `GET /api/inference/usage` | `inference:read` | Recent request records |
| `POST /api/inference/v1/chat/completions` | `inference:invoke` | Catalog-selected Chat Completions route |
| `POST /api/inference/v1/responses` | `inference:invoke` | Catalog-selected Responses route |

All routes require bearer authentication. Reauthorize older tokens that lack
these scopes. The catalog controls the provider endpoint and wire protocol.

### Charging and interrupted requests

The service determines reservation, usage settlement and admission policy.
Do not treat the CLI's dollar cost estimate or `--cost-ceiling` as the hosted
credit balance, a subscription allowance or a retail price.

Both wire APIs support server-sent events. A cancelled or interrupted request
may already have consumed model work. Check the service's request record and
account state before resubmitting; a disconnected stream does not establish a
refund or prove that no work ran.

| Failure | Action |
| --- | --- |
| HTTP 401 | Missing, invalid or revoked credential. Sign in again. |
| HTTP 403 | Missing scope, organization access or service entitlement. Read the returned reason before reauthorizing. |
| HTTP 402 | A payment or credit admission check rejected the request. Check account state and the deployment's supported billing flow. |
| HTTP 429 | A usage window, concurrency limit, unresolved request or provider throttle blocked the request. Inspect the reason and retry timing. |
| HTTP 503 | Hosted service, provider or account state unavailable. |
| Transport failure or hosted HTTP 5xx | The CLI doesn't automatically replay a potentially consumed request. Inspect usage before trying again. |

The gateway rejects detected model substitution. `0SEC_LLM_FALLBACK` configures
explicit backup routes; switching providers changes who receives the request
and which account pays.

Hosted HTTP 429 permits retry or configured fallback only with
`x-0sec-retry-safe: 1`, issued for pre-dispatch concurrency rejection.
Provider throttling and unresolved charges are unmarked and aren't replayed.

Plugin evolution's SDK model calls use the parent runtime's accounting when
routed through `hosted`. Subagents fork through the parent runtime's
child-inference factory and inherit its resolved account and route, subject to
the role-model and single-model policy. Workspace-trusted code can use external
clients outside SDK accounting. Keep model and route fixed when comparing
evolution results.

## Supported providers

| Provider | Env Var(s) | Default Model | Wire |
|----------|-----------|---------------|------|
| **ChatGPT Codex** | `0SEC_CHATGPT_ACCESS_TOKEN` (read first) / `0SEC_CHATGPT_OAUTH_REFRESH_TOKEN` | `gpt-5.5` | Responses (OAuth bearer) |
| **DeepSeek** | `DEEPSEEK_API_KEY` | `deepseek-flash` (V4.1 Flash) | Responses |
| **OpenRouter** | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.6` | Chat completions |
| **Azure OpenAI** | `AZURE_OPENAI_API_KEY` | `gpt-4o` (override with `AZURE_OPENAI_MODEL`) | Chat completions (default) or Responses |
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o` | Chat completions |
| **Z.ai GLM** | `Z_AI_API_KEY` | `glm-5.3` | Anthropic Messages |
| **Moonshot Kimi** | `KIMI_API_KEY` | `k3` | Anthropic Messages |
| **Alibaba Qwen** | `QWEN_API_KEY` | `qwen3.8-max` | Chat completions |
| **xAI Grok** | `XAI_API_KEY` | `grok-4.6` | Chat completions |
| **OpenCode Zen** | `OPENCODE_API_KEY` | `muse-spark-1.3-contributor-free` | Per-model (Responses, Anthropic Messages, Google generateContent, or Chat completions) |
| **GitHub Copilot** | `0SEC_COPILOT_GITHUB_TOKEN` | `gpt-4o` | Chat completions (device sign-in) |
| **Google Gemini Code Assist** | `0SEC_GEMINI_ACCESS_TOKEN` / `0SEC_GEMINI_OAUTH_REFRESH_TOKEN` | `gemini-2.5-pro` | Code Assist generateContent (browser sign-in) |
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | Anthropic Messages |

These direct connections are separate from [hosted inference](#hosted-inference).
Model families without a direct connection, such as Meta and Mistral, remain
available through gateways where your account permits them. Provider support
does not establish a subscription entitlement or guarantee a model is available.

### Current model choices

The bundled `/model` picker includes GPT-6 Astra (`gpt-6-astra`), DeepSeek V4.1
Flash (`deepseek-flash`), Claude Fable 5.1 / Opus 5 / Sonnet 5, Gemini 3.8 Flash
and 3.5 Flash-Lite, and GLM-5.3-Flash. Existing models remain selectable; adding
Astra does not change the OpenAI or ChatGPT Codex default.

Qwen choices include `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-max`,
`qwen3.7-plus`, `qwen3.6-plus`, and `qwen3.6-flash`. The offline catalog also
includes `qwen3.8-max-preview` without a price. They use `QWEN_API_KEY` and the
existing Token Plan endpoint; model availability depends on the account.
Qwen estimates use the [Models.dev Alibaba PAYG rates](https://models.dev/api.json),
not the subscription feed's zero-token rates. Plus requests above 256K input
tokens have higher pricing; reconcile Token Plan credits against the invoice.

Select the exact API id, for example:

```bash
env 0SEC_SELECTED_PROVIDER=openai 0SEC_MODEL=gpt-6-astra \
  0 review ./authorized-repo
```

Gemini can use the Google Code Assist subscription connection, OpenCode Zen
or OpenRouter. These are different accounts and routes. Pin the provider and
select an ID supported by that connection; a gateway catalog entry is not
evidence that the same model is available through Code Assist.

Displayed prices are estimates; reconcile charges against provider invoices.
[Astra's published base rates](https://developers.openai.com/api/docs/models/gpt-6-astra)
apply through 272K input tokens; longer requests and cache writes cost more.
[DeepSeek Flash](https://api-docs.deepseek.com/quick_start/pricing) is estimated
at peak rates ($0.30 input / $1.20 output per million tokens); off-peak is half
price. Gateway prices and subscription billing can differ from direct API rates.

## Credential priority

When no `--model` flag is given, the runtime selects a provider by checking
environment variables in this order. The **first variable found** wins:

1. **ChatGPT Codex** — `0SEC_CHATGPT_ACCESS_TOKEN` or `0SEC_CHATGPT_OAUTH_REFRESH_TOKEN`
2. **DeepSeek** — `DEEPSEEK_API_KEY`
3. **OpenRouter** — `OPENROUTER_API_KEY`
4. **Azure OpenAI** — `AZURE_OPENAI_API_KEY`
5. **OpenAI** — `OPENAI_API_KEY`
6. **Z.ai GLM** — `Z_AI_API_KEY`
7. **Moonshot Kimi** — `KIMI_API_KEY`
8. **Alibaba Qwen** — `QWEN_API_KEY`
9. **xAI Grok** — `XAI_API_KEY`
10. **OpenCode Zen** — `OPENCODE_API_KEY`
11. **GitHub Copilot** — `0SEC_COPILOT_GITHUB_TOKEN`
12. **Google Gemini Code Assist** — `0SEC_GEMINI_ACCESS_TOKEN` or `0SEC_GEMINI_OAUTH_REFRESH_TOKEN`
13. **Anthropic** — `ANTHROPIC_API_KEY`
14. **Hosted** — configured Cloud credentials, after the direct providers above.

Without a usable provider or Cloud credential, the runtime selects Anthropic
and reports a missing-credential failure.

**Two things override this fallback chain:**
- A `--model` (or `0SEC_MODEL`) value that maps to a specific provider — see
  [model routing](#model-routing) below — causes that provider's key to be used
  regardless of its position in the priority list.
- Explicit provider selection or forcing changes routing as described under
  [provider pinning](#provider-pinning).

## Model routing

Set `--model <id>` or run a command through `env 0SEC_MODEL=<id> 0 <command>`
when more than one credential is present.
0 routes recognized model prefixes to the configured provider:

| Model prefix | Provider | Notes |
|---|---|---|
| `glm-*`, `z-ai/*`, `*glm*` | Z.ai GLM | Anthropic-compatible Messages wire |
| `qwen*` | Alibaba Qwen | OpenAI-compatible `chat/completions` wire |
| `k3`, `kimi*` | Moonshot Kimi | Anthropic-compatible Messages wire |
| `grok*`, `xai/*`, `x-ai/*` | xAI Grok | OpenAI-compatible `chat/completions` wire |
| `opencode/<model-id>` | OpenCode Zen | Wire per upstream model family |
| `muse-spark*`, `mimo*`, `ling*`, `big-pickle`, `nemotron*`, `minimax*` | OpenCode Zen | Chat completions wire |
| `copilot/*` | GitHub Copilot | Requires the Copilot connection, independently of the underlying model family |
| `gemini*`, `google/*` | Google Gemini Code Assist | Requires Google OAuth; distinct from gateway Gemini routes |
| `claude*`, `anthropic/*`, `*sonnet*`, `*opus*`, `*haiku*` | Anthropic (preferred), OpenRouter (fallback) | Anthropic Messages wire |
| `gpt-*`, `o1`-`o4` | ChatGPT Codex (when configured), OpenAI (fallback) | Responses (Codex) or Chat completions (OpenAI) |
| `deepseek-flash`, `deepseek-v4-flash` | DeepSeek | Responses wire; V4.1 uses `deepseek-flash` |
| Azure Foundry deployment ids | Azure | Chat completions or Responses |

Without an explicit model, 0 follows the [credential priority](#credential-priority)
chain. Pin a model for predictable selection.

### Free OpenRouter model

When `OPENROUTER_API_KEY` is set, `--model free` maps to
`nvidia/nemotron-3-super-120b-a12b:free` — a no-cost tier for testing:

```bash
env OPENROUTER_API_KEY="sk-or-v1-..." \
  0 scan --target https://example.com --scope ./scope.json --model free
```

## Provider pinning

`0SEC_SELECTED_PROVIDER` selects the primary provider, bypassing ambient
credential priority. It accepts `openrouter`, `anthropic`, `openai`, `azure`,
`deepseek`, `chatgpt-codex`, `z-ai`, `kimi`, `qwen`, `xai`, `opencode`,
`copilot`, `google` and `hosted`.

Set `0SEC_MODEL` alongside an environment provider selection; only `hosted`
can defer its model to the service catalog. A separately configured explicit
model can use another route, for example a cross-model verification call.
Use the selected provider's own credentials and account-supported model ID.

```bash
env 0SEC_SELECTED_PROVIDER=deepseek 0SEC_MODEL=deepseek-flash \
  0 scan --target https://example.com --scope ./scope.json --mode web
```

`0SEC_FORCE_PROVIDER` is an unconditional override for benchmark control. It
applies even when `preferredModel` differs from `0SEC_MODEL`, which defeats
cross-family refutation — use it only in controlled benchmarks. Setting both
to different values throws an error.

## Setting your key

### macOS / Linux
```bash
# Set the provider key.
export Z_AI_API_KEY="..."
export QWEN_API_KEY="..."
export DEEPSEEK_API_KEY="..."

# Select its matching model at run time.
0 scan --target https://api.example.com --scope ./scope.json --model glm-5.3
0 scan --target https://api.example.com --scope ./scope.json --model qwen3.8-max

# Or use OpenRouter.
export OPENROUTER_API_KEY="sk-or-v1-..."

# ChatGPT Codex subscription auth. `0SEC_*` names begin with a digit, so
# pass the token with `env` rather than a shell `export`.
env 0SEC_CHATGPT_OAUTH_REFRESH_TOKEN="..." \
  0 review ./authorized-repo --runtime api
# Or use 0SEC_CHATGPT_ACCESS_TOKEN; it is read first when both are present.
```

### GitHub Actions

Add the key as a repository secret and pass it as `env` on the step. The dedicated
composite action is still [planned](/ci/github-action/), so today you invoke the
CLI through the container image:

```yaml
- run: |
    docker run --rm -v "$PWD:/work" -w /work \
      -e OPENROUTER_API_KEY \
      ghcr.io/0sec-labs/0sec:latest review .
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

## ChatGPT Codex authentication

ChatGPT Codex uses its own authentication file, separate from the console's
API-key store. When neither `0SEC_CHATGPT_ACCESS_TOKEN` nor
`0SEC_CHATGPT_OAUTH_REFRESH_TOKEN` is supplied, the runtime can read tokens
from `~/.codex/auth.json`, written by `codex login`. Override the path with
`0SEC_CHATGPT_AUTH_FILE`; an account ID comes from `0SEC_CHATGPT_ACCOUNT_ID`
or the same file. Prefer the canonical spelling over the older
`0SEC_CODEX_AUTH_JSON_PATH`.

Path precedence for the auth file:
1. `0SEC_CHATGPT_AUTH_FILE` (canonical, matches the runtime).
2. `0SEC_CODEX_AUTH_JSON_PATH` (deprecated — honoured as a fallback).
3. `~/.codex/auth.json` (the default when neither override is set).

The CLI bootstrap runs `maybeLoadCodexAuth` at startup, loading the auth file
into `0SEC_CHATGPT_*` env vars if no token is present. A logged-in `codex`
session takes priority over stale `AZURE_OPENAI_API_KEY` / `OPENAI_API_KEY`
left in a dev shell.

In the hosted-enabled CLI candidate, open `/connect` and select **ChatGPT
Codex** under **Provider subscription**. 0 runs `codex login --device-auth`,
shows the device instructions, and reloads `~/.codex/auth.json` after success.
Choose **OpenAI** under **Use my own API key** for `OPENAI_API_KEY` access.
The separate **0cloud → Sign in** choice authorizes a Cloud organization.

Every `0` run loads that file into the environment before any subcommand
runs, so a codex-login file is picked up everywhere — the console `/providers`
view, `0 doctor`, and scans/reviews/audits. An explicit environment value always wins,
and a missing or malformed file is ignored quietly. The `/providers` table
never checks the filesystem: anything reading it without the CLI's startup
load (for example, embedded in a custom tool) shows "not configured".

## Console credential store

In `/connect`, choose **Use my own API key**, select a provider and enter its
key. ChatGPT Codex has a separate subscription sign-in. Local, BYOK and
provider-subscription workflows need no Cloud account.

Keys are written to `credentials.json` in the [state
directory](/configuration/#state-directory) (`~/.0sec/` by default), re-tightened
to owner-only (`0600` file, `0700` dir) on every save.

**An explicit environment value always wins over the stored value.** The store
only fills a variable the environment doesn't already carry.

**Stored credentials are not encrypted.** They're plaintext, protected only by
file permissions. Treat `credentials.json` like an exported secret in a shell
profile.

The BYOK `/model` picker starts with curated models. **Tab** opens the full
catalog; typing a query searches the full catalog from either view.
Check credentials and account access before use. The detail pane shows setup
hints and credential sources; missing prices remain unknown.
Use `/connect` to add credentials and `/providers` to inspect them.
Model selections apply to the current audit while idle or after its active
turn finishes. A selection requiring an unconnected provider remains staged:
connect the provider, then select the model again. A normal `/connect` choice
alone prepares the next chat rather than switching a healthy current runtime.
See [Model picker](/console/#model-picker).

## When to use OpenRouter

Use OpenRouter for model families with no direct provider credential. It also
serves as fallback when a `claude-*` model is requested without
`ANTHROPIC_API_KEY`: the runtime checks for `OPENROUTER_API_KEY` before giving
up.

## Provider failover

`0SEC_LLM_FALLBACK` configures an ordered chain of backup providers when the
primary exhausts its retry budget or hits a plan-quota limit:

```bash
env 0SEC_LLM_FALLBACK=deepseek:deepseek-flash,azure:gpt-5-deployment \
  0 review ./authorized-repo
```

Each entry is `<providerId>:<model>`, comma-separated. The runtime advances
through eligible routes sequentially and skips entries without the required
credentials. Supported IDs are `openrouter`, `anthropic`, `openai`, `azure`,
`deepseek`, `chatgpt-codex`, `z-ai`, `kimi`, `qwen`, `xai`, `opencode`,
`copilot`, `google` and `hosted`. Hosted replay restrictions still apply;
adding a fallback is not permission to retry a potentially consumed request.

## Azure OpenAI configuration

0 needs an Azure base URL and deployment/model name in addition to the API
key, either from env vars or from `~/.codex/config.toml` when Codex is
configured against Azure.

| Variable | Required | Description |
|----------|----------|-------------|
| `AZURE_OPENAI_API_KEY` | Yes | Your Azure OpenAI API key |
| `AZURE_OPENAI_BASE_URL` | Yes, unless 0 can read it from Codex config | Base URL for your Azure deployment. For the Responses API this should include `/openai/v1`. |
| `AZURE_OPENAI_MODEL` | Yes, unless 0 can read it from Codex config | Azure deployment/model name (not just a generic model family string) |
| `AZURE_OPENAI_WIRE_API` | No | Wire API format: `chat_completions` (default) or `responses` |

```bash
export AZURE_OPENAI_API_KEY="your-azure-key"
export AZURE_OPENAI_BASE_URL="https://your-resource.openai.azure.com/openai/v1"
export AZURE_OPENAI_MODEL="gpt-4o"
export AZURE_OPENAI_WIRE_API="responses"
```

If you rely on Codex config, make sure `~/.codex/config.toml` points at Azure with
a usable base URL and model/deployment. Incomplete Azure config stops with a
configuration error before any scan starts.

The runtime probes the Azure endpoint once per process to resolve the deployment
region for diagnostics.

## Alternative: CLI runtimes

To skip API keys entirely, use CLI runtimes. Claude runs live scans through its
subscription loop; Codex and Gemini are source-review oriented:

```bash
# Use Claude Code CLI for an authorized live target
0 scan --target https://api.example.com/chat --scope ./scope.json --runtime claude
# Use Codex CLI for source review
0 review ./my-repo --runtime codex

# Use Gemini CLI
0 review ./my-repo --runtime gemini
```

Source-review CLI runtimes need no API key — the CLI handles auth. Codex live
scans use the direct ChatGPT Codex provider, so they need
`0SEC_CHATGPT_OAUTH_REFRESH_TOKEN` rather than the Codex CLI.

<span id="0sec-doctor--credential-readiness"></span>
## `0 doctor` — credential readiness

Inspect runtime and credential configuration:

```bash
0 doctor
```

Authenticated model access requires a separate request; `doctor` checks configuration.

It reports:
- Node.js version compatibility (20+ required).
- **API runtime** status: `configured` (credential found), `bad` (configured but
  unusable), or `missing` (no credential).
- **CLI runtimes** found on `PATH` (claude, codex, gemini).
- Configuration errors when the API runtime is set up but cannot be used.

Under Bun with a compatible terminal, doctor launches the richer OpenTUI view.