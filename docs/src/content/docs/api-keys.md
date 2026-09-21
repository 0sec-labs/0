---
title: API Keys
description: Supported LLM providers, environment variables, credential priority, model routing, and provider failover.
---

The local 0 CLI can use your own provider key or a supported provider
subscription without a 0cloud account. Hosted model access routes inference
through 0cloud; it does not move your local tools into a managed sandbox.
Managed security work has separate authorization, access and billing.

<a id="hosted-inference-draft"></a>
<a id="0-hosted-inference-draft"></a>

## Hosted inference

Hosted model access and managed execution are separate service contracts.
The public site describes hosted plans by inquiry; an available login page,
successful authentication or model listing is not proof of production-paid
readiness or permission to dispatch managed work. Use a compatible CLI and
service revision; follow [Cloud setup](/getting-started/#hosted-models).

The `api` runtime's `hosted` provider uses a scoped organization credential.
The service holds supplier keys and receives model context, including tool
results. Tools execute on your configured local executor.
The managed service additionally distinguishes organization product modes:
an inference-only organization cannot submit security scans, and a review-only
organization is limited to its review workflow. A hosted inference credential
does not confer general managed-security execution rights.

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

The gateway rejects detected model substitution. `ZERO_LLM_FALLBACK` configures
explicit backup routes; switching providers changes who receives the request
and which account pays.

Hosted HTTP 429 permits retry or configured fallback only with
`x-0-retry-safe: 1`, issued for pre-dispatch concurrency rejection.
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
| **ChatGPT Codex** | `ZERO_CHATGPT_ACCESS_TOKEN` (read first) / `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN` | `gpt-5.5` | Responses (OAuth bearer) |
| **DeepSeek** | `DEEPSEEK_API_KEY` | `deepseek-flash` (V4.1 Flash) | Responses |
| **OpenRouter** | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.6` | Chat completions by default; optional Responses |
| **Azure OpenAI** | `AZURE_OPENAI_API_KEY` plus endpoint/deployment configuration | Explicit deployment required; do not rely on the internal `gpt-4o` fallback | Chat completions by default; optional or model-required Responses |
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o` | Chat completions by default; optional or model-required Responses |
| **Z.ai GLM** | `Z_AI_API_KEY` | `glm-5.3` | Anthropic Messages |
| **Moonshot Kimi** | `KIMI_API_KEY` | `k3` | Anthropic Messages |
| **Alibaba Qwen** | `QWEN_API_KEY` | `qwen3.8-max` | Chat completions |
| **xAI Grok** | `XAI_API_KEY` | `grok-4.6` | Chat completions by default; optional Responses |
| **OpenCode Zen** | `OPENCODE_API_KEY` | `muse-spark-1.3-contributor-free` | Per-model (Responses, Anthropic Messages, Google generateContent, or Chat completions) |
| **GitHub Copilot** | `ZERO_COPILOT_GITHUB_TOKEN` | `gpt-4o` | Chat completions (device sign-in) |
| **Google Gemini Code Assist** | `ZERO_GEMINI_ACCESS_TOKEN` / `ZERO_GEMINI_OAUTH_REFRESH_TOKEN` | `gemini-2.5-pro` | Code Assist generateContent (browser sign-in) |
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | Anthropic Messages |

These direct connections are separate from [hosted inference](#hosted-inference).
Model families without a direct connection, such as Meta and Mistral, remain
available through gateways where your account permits them. Provider support
does not establish a subscription entitlement or guarantee a model is available.

OpenAI, OpenRouter, xAI and Azure accept `OPENAI_WIRE_API`,
`OPENROUTER_WIRE_API`, `XAI_WIRE_API` and `AZURE_OPENAI_WIRE_API`, respectively,
with values `chat_completions` or `responses`. Other values are errors.
The exact Azure `gpt-5.6-sol` and OpenAI `gpt-5.6-luna` routes upgrade to Responses
for tool support. OpenCode determines its wire by model family: GPT/Grok/Muse
use Responses, Claude/Qwen use Messages, Gemini uses generateContent, and
DeepSeek/GLM/Kimi/MiMo/Ling/Nemotron/MiniMax use Chat Completions.

Provider credentials do not authorize sending arbitrary source, secrets or
customer data to that provider. Model context includes selected source and tool
results. Establish data-handling permission separately from target-testing
authorization.

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
env ZERO_SELECTED_PROVIDER=openai ZERO_MODEL=gpt-6-astra \
  0 review ./authorized-repo --runtime api
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

Within the API runtime, when there is no provider pin or model-to-provider match,
the following ambient credential order applies. `--model` takes precedence over
`ZERO_MODEL`; loading a credential is not the same as selecting that provider.

1. **ChatGPT Codex** — `ZERO_CHATGPT_ACCESS_TOKEN` or `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN`
2. **DeepSeek** — `DEEPSEEK_API_KEY`
3. **OpenRouter** — `OPENROUTER_API_KEY`
4. **Azure OpenAI** — `AZURE_OPENAI_API_KEY`
5. **OpenAI** — `OPENAI_API_KEY`
6. **Z.ai GLM** — `Z_AI_API_KEY`
7. **Moonshot Kimi** — `KIMI_API_KEY`
8. **Alibaba Qwen** — `QWEN_API_KEY`
9. **xAI Grok** — `XAI_API_KEY`
10. **OpenCode Zen** — `OPENCODE_API_KEY`
11. **GitHub Copilot** — `ZERO_COPILOT_GITHUB_TOKEN`
12. **Google Gemini Code Assist** — `ZERO_GEMINI_ACCESS_TOKEN` or `ZERO_GEMINI_OAUTH_REFRESH_TOKEN`
13. **Anthropic** — `ANTHROPIC_API_KEY`
14. **Hosted** — configured Cloud credentials, after the direct providers above.

Without a usable provider or Cloud credential, the runtime selects Anthropic
and reports a missing-credential failure.

**Two things override this fallback chain:**
- A `--model` (or `ZERO_MODEL`) value that maps to a specific provider — see
  [model routing](#model-routing) below — causes that provider's key to be used
  when that provider is configured, regardless of its ambient priority.
- Explicit provider selection or forcing changes routing as described under
  [provider pinning](#provider-pinning).

An explicit `--api-key` is another input: without a provider pin, `sk-or-`
selects OpenRouter, `sk-ant-` selects Anthropic, and other key shapes select
OpenAI-compatible access **before** natural-model routing. Prefer environment
credentials plus an explicit provider/model pair; command-line secrets can
appear in process listings and shell history. `hosted` and `chatgpt-codex`
require their own authentication and reject a generic runtime API key.

## Model routing

Set `--model <id>` or run a command through `env ZERO_MODEL=<id> 0 <command>`
when more than one credential is present.
0 routes recognized model prefixes to the configured provider:

| Model prefix / identifier | Provider | Notes |
|---|---|---|
| `openrouter/*` | OpenRouter | Requires its own key |
| `glm-*`, `z-ai/*`, IDs containing `glm` | Z.ai GLM | Messages wire |
| `qwen*`, exact `deepseek-v4-flash-0731` | Alibaba Qwen | Token Plan by default; separate account from direct DeepSeek |
| `k3*`, `kimi*` | Moonshot Kimi | Messages wire |
| `grok*`, `xai/*`, `x-ai/*` | xAI Grok | Configured compatible wire |
| `opencode/<model-id>` | OpenCode Zen | Prefix stripped; wire chosen by model family |
| `muse-spark*`, `mimo*`, `ling*`, `big-pickle`, `nemotron*`, `minimax*` | OpenCode Zen | Muse uses Responses; the other listed families use Chat Completions |
| `copilot/*` | GitHub Copilot | Prefix stripped; independently authenticated connection |
| `gemini*`, `google/*` | Google Gemini Code Assist | Requires Google OAuth; not the public Gemini API-key route |
| `claude*`, `anthropic/*`, IDs containing `sonnet`, `opus`, `haiku` | Anthropic, then OpenRouter | OpenRouter fallback requires its key |
| `gpt-*`, `o1`–`o4` | ChatGPT Codex, then OpenAI | Configured Codex auth wins this family match |
| Exact `deepseek-flash`, `deepseek-v4-flash` | Direct DeepSeek | Responses; checked before Azure deployment aliases |
| Recognized Foundry deployment IDs | Azure | Checked before general model-family routing |

These are routing heuristics, not entitlement checks or a model availability
catalog. A family match without its credential falls through to ambient
priority; a request can then fail at the selected provider. Use a provider pin
for a deterministic route, especially with arbitrary Azure deployment names.

The Azure routing allowlist includes `DeepSeek-V4-Pro`, `DeepSeek-V4-Flash`,
`Kimi-K2.7-Code`, `gpt-oss-120b`, `gpt-5.4` and the GPT-5.6 Sol/Luna/Terra IDs
(case-insensitive). The exact lowercase `deepseek-v4-flash` is first treated as
direct DeepSeek. Pin `azure` rather than depending on casing to choose a bill.
Azure V4.1 pricing aliases do not themselves add a natural-provider route.

For multiple models **inside one console audit**, use the
[role-model picker](/configuration/#multi-model-role-routing). Children retain
the parent's account and transport: choose models in that provider's catalog.
That is distinct from independently created workflow runtimes, which can route
different model IDs to different configured providers.

<span id="free-openrouter-model"></span>
### OpenRouter `free` alias

When the selected API provider is OpenRouter, `--model free` maps to
`nvidia/nemotron-3-super-120b-a12b:free`. The alias is not an entitlement or an
availability guarantee; provider limits and current terms still apply.

```bash
env OPENROUTER_API_KEY="sk-or-v1-..." ZERO_SELECTED_PROVIDER=openrouter \
  0 scan --target https://example.com --scope ./scope.json --runtime api --model free
```

## Provider pinning

`ZERO_SELECTED_PROVIDER` selects the primary provider, bypassing ambient
credential priority. It accepts `openrouter`, `anthropic`, `openai`, `azure`,
`deepseek`, `chatgpt-codex`, `z-ai`, `kimi`, `qwen`, `xai`, `opencode`,
`copilot`, `google` and `hosted`.

Set `ZERO_MODEL` alongside an environment provider selection; only `hosted`
can defer its model to the service catalog. A separately configured explicit
model can use another route, for example a cross-model verification call.
Use the selected provider's own credentials and account-supported model ID.

```bash
env ZERO_SELECTED_PROVIDER=deepseek ZERO_MODEL=deepseek-flash \
  0 scan --target https://example.com --scope ./scope.json --mode web --runtime api
```

`ZERO_FORCE_PROVIDER` is an unconditional override for benchmark control. It
applies even when `preferredModel` differs from `ZERO_MODEL`, which defeats
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
0 scan --target https://api.example.com --scope ./scope.json --runtime api --model glm-5.3
0 scan --target https://api.example.com --scope ./scope.json --runtime api --model qwen3.8-max

# Or use OpenRouter.
export OPENROUTER_API_KEY="sk-or-v1-..."

# ChatGPT Codex subscription auth. `ZERO_*` names begin with a digit, so
# pass the token with `env` rather than a shell `export`.
env ZERO_CHATGPT_OAUTH_REFRESH_TOKEN="..." \
  0 review ./authorized-repo --runtime api
# Or use ZERO_CHATGPT_ACCESS_TOKEN; it is read first when both are present.
```

### GitHub Actions

Add the key as a repository secret and pass it as `env` on the step. The dedicated
composite action is still [planned](/ci/github-action/); one supported approach
is invoking the CLI through the container image:

```yaml
- run: |
    docker run --rm -v "$PWD:/work" -w /work \
      -e OPENROUTER_API_KEY \
      ghcr.io/0sec-labs/0:latest review . --runtime api
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

## ChatGPT Codex authentication

ChatGPT Codex uses its own authentication file, separate from the console's
API-key store. When neither `ZERO_CHATGPT_ACCESS_TOKEN` nor
`ZERO_CHATGPT_OAUTH_REFRESH_TOKEN` is supplied, the runtime can read tokens
from `~/.codex/auth.json`, written by `codex login`. Override the path with
`ZERO_CHATGPT_AUTH_FILE`; an account ID comes from `ZERO_CHATGPT_ACCOUNT_ID`
or the same file. Prefer the canonical spelling over the older
`ZERO_CODEX_AUTH_JSON_PATH`.

Path precedence for the auth file:
1. `ZERO_CHATGPT_AUTH_FILE` (canonical, matches the runtime).
2. `ZERO_CODEX_AUTH_JSON_PATH` (deprecated — honoured as a fallback).
3. `~/.codex/auth.json` (the default when neither override is set).

The CLI bootstrap runs `maybeLoadCodexAuth` at startup, loading the auth file
into `ZERO_CHATGPT_*` env vars if no token is present. A logged-in `codex`
session takes priority over stale `AZURE_OPENAI_API_KEY` / `OPENAI_API_KEY`
left in a dev shell.

In the interactive console, open `/connect` and select **ChatGPT
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
directory](/configuration/#state-directory) (`~/.0/` by default), re-tightened
to owner-only (`0600` file, `0700` dir) on every save.

**A nonblank environment credential wins over the stored account.** Empty or
whitespace-only values do not block loading a stored credential. For a provider
with multiple auth variables, any usable environment credential keeps that
provider's stored account from being mixed into the connection.

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

### Other browser and subscription connections

`/connect` also offers browser/device flows for xAI, Kimi, GitHub Copilot,
Google Gemini Code Assist and OpenRouter. Their account semantics differ:

| Connection | Authentication behavior |
| --- | --- |
| xAI / Kimi | Device-code sign-in; stores an OAuth account |
| GitHub Copilot | GitHub device-code token, used for the Copilot endpoint; an eligible Copilot account and model access are still required |
| Google Gemini Code Assist | Google browser PKCE flow with loopback callback; stores OAuth access/refresh tokens; resolves project/tier at request time |
| OpenRouter | Browser PKCE flow provisions an API key; it is not an unlimited subscription |
| ChatGPT Codex | Official `codex login --device-auth`; tokens remain in the Codex auth file |

The console store supports active accounts per provider and stores API keys or
OAuth records in plaintext with the same owner-only permissions. This store is
used by console connection flows; do not assume a saved console credential is
exported to an unrelated shell or every headless command. For automation,
provide the required environment credentials explicitly. Subscription access
is governed by the supplier, not by 0's displayed token-dollar estimate.

### Jev credentials are separate

Jev assistance is off until `ZERO_JEV_FEATURES` explicitly names a workflow.
It does not reuse your chat-provider selection: Vercel needs
`AI_GATEWAY_API_KEY`, Typesafe needs `TYPESAFE_API_KEY`, and the Cloud adapter
needs both `ZERO_JEV_CLOUD_TOKEN` and `ZERO_JEV_CLOUD_URL`. The kernel-only
`classifier` route needs no key but still sends data to an external service.
See [opt-in Jev assistance](/configuration/#opt-in-jev-assistance) before
enabling data egress and [separate budgets](/budget-management/#jev-advisory-budgets).

## When to use OpenRouter

Use OpenRouter for model families with no direct provider credential. It also
serves as fallback when a `claude-*` model is requested without
`ANTHROPIC_API_KEY`: the runtime checks for `OPENROUTER_API_KEY` before giving
up.

## Provider failover

`ZERO_LLM_FALLBACK` configures an ordered chain of backup providers when the
primary exhausts its retry budget or hits a plan-quota limit:

```bash
env ZERO_LLM_FALLBACK=deepseek:deepseek-flash,azure:gpt-5-deployment \
  0 review ./authorized-repo --runtime api
```

Each entry is `<providerId>:<model>`, comma-separated. The runtime advances
through eligible routes sequentially and skips entries without the required
credentials. Supported IDs are `openrouter`, `anthropic`, `openai`, `azure`,
`deepseek`, `chatgpt-codex`, `z-ai`, `kimi`, `qwen`, `xai`, `opencode`,
`copilot`, `google` and `hosted`. Hosted replay restrictions still apply;
adding a fallback is not permission to retry a potentially consumed request.

## Azure OpenAI configuration

Configure an Azure API key, endpoint and actual deployment ID. The most
repeatable setup supplies all three and pins the provider:

```bash
export AZURE_OPENAI_API_KEY="your-azure-key"
export AZURE_OPENAI_BASE_URL="https://your-resource.openai.azure.com/openai/v1"
export AZURE_OPENAI_WIRE_API="responses"
env ZERO_SELECTED_PROVIDER=azure ZERO_MODEL="your-deployment-id" \
  0 review ./authorized-repo --runtime api --cost-ceiling 5
```

| Setting | Resolution |
| --- | --- |
| API key | `AZURE_OPENAI_API_KEY` (or explicit runtime API key with Azure selected) |
| Endpoint, unpinned detection | `AZURE_OPENAI_BASE_URL`, then `OPENAI_BASE_URL`, then the Azure provider section of `~/.codex/config.toml` |
| Endpoint, explicit pin / fallback entry | `AZURE_OPENAI_BASE_URL`, then `OPENAI_BASE_URL`; no Codex-file endpoint fallback in this resolver |
| Model | Explicit `--model`, then `ZERO_MODEL`; ambient Azure detection can use `AZURE_OPENAI_MODEL` or an Azure-backed Codex config model |
| Wire | `AZURE_OPENAI_WIRE_API` accepts `chat_completions` or `responses`; ambient detection can inherit Codex's Azure `wire_api`, otherwise Chat Completions |

An environment provider pin requires an explicit model; `AZURE_OPENAI_MODEL`
alone is not that pin's model argument. The Azure config parser accepts the
Azure section's model or a top-level model only when Codex's active provider is
Azure. It does not borrow an unrelated provider's model. Incomplete configuration
fails readiness rather than intentionally using a guessed endpoint/deployment.

Include `/openai/v1` in a Responses base URL. `gpt-5.6-sol` automatically
upgrades from Chat Completions to Responses for function-tool support.

The runtime probes the Azure endpoint once per process to resolve the deployment
region for diagnostics.
An unavailable region probe is not a residency guarantee.

The bundled estimator distinguishes Foundry deployment tariffs from direct
supplier APIs. Current Azure rows, in USD per million tokens, include:

| Deployment pricing key | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| `deepseek-v4.1-flash` | 0.375 | 0.008 | 1.50 |
| `DeepSeek-V4-Pro` | 1.74 | Not separately represented | 3.48 |
| `DeepSeek-V4-Flash` | 0.19 | Not separately represented | 0.51 |
| `Kimi-K2.7-Code` | 0.95 | 0.19 | 4.00 |
| `gpt-oss-120b` | 0.15 | Not separately represented | 0.60 |
| `gpt-5.6-sol` | 5.00 | 0.50 | 30.00 |
| `gpt-5.6-luna` | 1.00 | 0.10 | 6.00 |
| `gpt-5.6-terra` | 2.50 | 0.25 | 15.00 |

The V4.1 row follows the repository's September 17 Azure Retail Prices snapshot
for Fireworks-on-Foundry Global meters, not direct DeepSeek's $0.30/$1.20 tariff.
`fw-deepseek-v4.1-flash`, supported case variants and version-suffixed aliases
resolve to the same pricing row. Custom deployment names may fall back to a
generic estimate. This table is not a live quotation: Azure Cost Management
and the invoice remain authoritative for region, deployment type, cache writes,
long context and actual usage. See [cost estimate limits](/budget-management/#interpreting-cost-estimates).

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

Source-review CLI runtimes use their CLI's authentication. Codex live scans use
the direct ChatGPT Codex provider instead of a Codex CLI target-tool wrapper;
the CLI bootstrap can load `~/.codex/auth.json`, or you can explicitly supply
`ZERO_CHATGPT_ACCESS_TOKEN` / `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN`.

<span id="0-doctor--credential-readiness"></span>
## `0 doctor` — credential readiness

Inspect runtime and credential configuration:

```bash
0 doctor
```

Authenticated model access requires a separate request; `doctor` checks configuration.

It reports:
- Runtime version compatibility. The npm package requires Node.js 24+; the native installer supplies a Bun-based binary.
- **API runtime** status: `configured` (credential found), `bad` (configured but
  unusable), or `missing` (no credential).
- **CLI runtimes** found on `PATH` (claude, codex, gemini).
- Configuration errors when the API runtime is set up but cannot be used.

Under Bun with a compatible terminal, doctor launches the richer OpenTUI view.