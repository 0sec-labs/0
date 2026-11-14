---
title: API Keys
description: Connect a model provider in the browser or configure credentials for CLI work.
---

Open **Connections** in the browser to add an API key or sign in to a supported
subscription. Then choose a model in your conversation. For headless work, use
the environment variables below.

Model availability and billing belong to your provider account.
Local model connections need no platform account.

## Supported providers

| Provider | Credential or setup |
| --- | --- |
| ChatGPT Codex | Sign in through Connections or use `codex login`; advanced overrides: `ZERO_CHATGPT_ACCESS_TOKEN` / `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, endpoint and deployment ID |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Z.ai GLM | `Z_AI_API_KEY` |
| Moonshot Kimi | `KIMI_API_KEY` |
| Alibaba Qwen | `QWEN_API_KEY` and the endpoint for your product/region |
| xAI Grok | `XAI_API_KEY` or a configured device sign-in |
| OpenCode Zen / Go | `OPENCODE_API_KEY`; set `OPENCODE_BASE_URL` for your account endpoint |
| Cline / ClinePass | `CLINE_API_KEY`; choose a full `cline-pass/*` model ID for Pass |
| Together AI | `TOGETHER_API_KEY`; pin the provider or use a `together/<model-id>` model ID |
| GitHub Copilot | Device sign-in; advanced override: `ZERO_COPILOT_GITHUB_TOKEN` |
| Google Gemini Code Assist | Browser sign-in; advanced overrides: `ZERO_GEMINI_ACCESS_TOKEN` / `ZERO_GEMINI_OAUTH_REFRESH_TOKEN` |

Gateways can expose additional model families through the same connection.
For OpenAI-compatible servers, see [custom providers](#custom-ai-providers-including-9router).

OpenAI, OpenRouter, xAI and Azure accept `OPENAI_WIRE_API`,
`OPENROUTER_WIRE_API`, `XAI_WIRE_API` and `AZURE_OPENAI_WIRE_API`: use
`chat_completions` or `responses`. Some model routes select Responses for tool
support. OpenCode chooses its wire by model family.

### Current model choices

Choose from the models returned for your connection in the browser's model menu
or **Models** page. Discovery failures are shown there. Search by exact model ID;
public catalogs add pricing and context metadata, but do not grant access.

For a CLI review, use the exact ID your account supports. For example:

```bash
env ZERO_SELECTED_PROVIDER=openai ZERO_MODEL=gpt-6-astra \
  0 scan source ./authorized-repo --runtime api
```

A model offered by OpenRouter or OpenCode may not be available through a direct
subscription. Each connection has its own credentials, catalog and limits.
Displayed token prices are estimates; check your provider's billing records.

## Custom AI providers (including 9Router)

Choose **OpenAI / Custom AI Provider** in Connections. Enter the provider's API
base URL, including its version path (for example `http://localhost:20128/v1`),
its exact **Custom model ID**, and its **API key**. HTTP and HTTPS endpoints are
supported. The model ID does not need to appear in the catalog. Save the settings,
connect the key, then choose this connection and model in Models.

Custom providers use the existing OpenAI-compatible Chat Completions transport
and OpenAI credential slot. In a shell, configure the same connection with:

```bash
export OPENAI_API_KEY="your-provider-key"
export OPENAI_BASE_URL="http://localhost:20128/v1"
export OPENAI_MODEL="your-provider/model-id"
export ZERO_SELECTED_PROVIDER="openai"
0
```

Explicit model selections override `OPENAI_MODEL`; explicit exported endpoint and
model values override saved connection settings. Use the complete API base path:
0 appends `/chat/completions`. Providers requiring Responses can set
`OPENAI_WIRE_API=responses`.

## Cline and ClinePass

Create a programmatic API key at **app.cline.bot → Settings → API Keys**, then
connect **Cline / ClinePass** in the console's Connections screen or export
`CLINE_API_KEY`. Inference uses `https://api.cline.bot/api/v1`; an explicit
`CLINE_BASE_URL` changes the endpoint. 0 does not read desktop or extension
account tokens.

Saved API-key credentials and custom endpoints are reused by browser and
headless chat, the model picker, and `scan source` / `scan`. Explicit environment variables take
precedence over saved connection settings.

Cline usage billing and ClinePass share this API key and endpoint. The model ID
selects the billing lane: ordinary IDs such as `anthropic/claude-sonnet-4-6` use
usage billing, while full `cline-pass/*` slugs require an active Pass subscription.
The default Cline model uses usage billing, so select a Pass model explicitly:

```bash
export CLINE_API_KEY="..."
env ZERO_SELECTED_PROVIDER=cline ZERO_MODEL=cline-pass/glm-5.3 \
  0 scan source ./authorized-repo --runtime api
```

The model picker reads Cline's public catalog and marks Pass choices **access
unverified**. Catalog presence does not prove subscription entitlement. ClinePass
has rolling 5-hour, weekly and monthly quotas. Pass cost estimates use reference
quota rates, not additional API charges or remaining quota; check the Cline
dashboard for actual usage. DeepSeek estimates use peak rates and Qwen Plus
estimates use the ≤256K input tier.

See Cline's official [authentication guide](https://github.com/cline/cline/blob/main/docs/api/authentication.mdx)
and [ClinePass guide](https://github.com/cline/cline/blob/main/docs/getting-started/clinepass.mdx).

## Together AI

Create a key at **api.together.ai → Settings → API Keys**, then connect
**Together AI** in the console's Connections screen or export `TOGETHER_API_KEY`.
Inference uses Together's OpenAI-compatible Chat Completions endpoint at
`https://api.together.ai/v1`. Set `TOGETHER_BASE_URL` to change it, for example
to the US-only endpoint `https://us-api.together.ai/v1`. Together charges 1.25×
standard input, cached-input, and output rates there; 0's catalog estimates do not
include this endpoint surcharge. Together's own SDKs
use the bare origin (`https://api.together.ai`), so an override with no path
gets `/v1` appended; any explicit path is used as written.

Together model IDs are `<organization>/<model>`, for example
`openai/gpt-oss-120b`. Several of these collide with other providers' model
families (`Qwen/…`, `zai-org/GLM-…`, `deepseek-ai/…`), so 0 never routes a model
to Together by family. Select Together explicitly, either by pinning the
provider or with a `together/` prefix, which is removed before the request:

```bash
export TOGETHER_API_KEY="..."
env ZERO_SELECTED_PROVIDER=together ZERO_MODEL=openai/gpt-oss-120b \
  0 scan source ./authorized-repo --runtime api
# or, with no provider pin:
0 scan source ./authorized-repo --runtime api --model together/openai/gpt-oss-120b
```

The prefix is removed once, so an ID that itself begins with `together/` is
written `together/together/<model>`. The default model is `openai/gpt-oss-120b`.

The model picker lists Together's `chat` models that publish valid input and output token prices,
including zero-priced models.
That is Together's public catalog, so rows are marked as unverified for your
account: a priced model can still be unavailable on serverless (Together
returns `model_not_available` and asks for a dedicated endpoint). Any model ID
you can call works even when it is not listed, including your own dedicated
endpoints and fine-tunes. Choose one explicitly with `--model` or `ZERO_MODEL`.
Set `TOGETHER_MODEL_LIST=all` to list every `chat` model your key can see,
including rows with no valid published price. The list can be thousands of
entries long, so search by exact ID. After discovery, 0 uses valid published
[USD-per-million-token prices](https://docs.together.ai/docs/serverless/models)
for the Together route when at least one token rate is positive. All-zero or
missing token prices leave the existing estimate unchanged.

0 sends no Together-specific parameters. `reasoning_effort` is sent only when
you set it, and Together honours it only on GPT-OSS models. Agent workflows need
a model that supports function tool calling.

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
11. **Cline** — `CLINE_API_KEY`
12. **GitHub Copilot** — `ZERO_COPILOT_GITHUB_TOKEN`
13. **Google Gemini Code Assist** — `ZERO_GEMINI_ACCESS_TOKEN` or `ZERO_GEMINI_OAUTH_REFRESH_TOKEN`
14. **Anthropic** — `ANTHROPIC_API_KEY`
15. **Together AI** — `TOGETHER_API_KEY`

Without a usable provider credential, the runtime reports a missing-credential
failure. Saved Cloud credentials do not become a model provider.

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
appear in process listings and shell history. `chatgpt-codex` requires its own
authentication and rejects a generic runtime API key.

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
| `cline/<provider>/<model-id>` | Cline API | Strip only `cline/`; keep the vendor/model slug |
| `cline-pass/*` | Cline API | Preserve the full slug; active ClinePass subscription required |
| `together/<org>/<model>` | Together AI | Prefix stripped; vendor-style IDs are never routed to Together by family |
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

Use **Models** for worker-role choices in the browser. See
[multi-model routing](/configuration/#multi-model-role-routing) for inherited
connections and approved overrides.

<span id="free-openrouter-model"></span>
### OpenRouter `free` alias

When the selected API provider is OpenRouter, `--model free` maps to
`nvidia/nemotron-3-super-120b-a12b:free`. The alias is not an entitlement or an
availability guarantee; provider limits and current terms still apply.

```bash
env OPENROUTER_API_KEY="sk-or-v1-..." ZERO_SELECTED_PROVIDER=openrouter \
  0 scan web --target https://example.com --scope ./scope.json --runtime api --model free
```

## Provider pinning

`ZERO_SELECTED_PROVIDER` selects the primary provider, bypassing ambient
credential priority. It accepts `openrouter`, `anthropic`, `openai`, `azure`,
`deepseek`, `chatgpt-codex`, `z-ai`, `kimi`, `qwen`, `xai`, `opencode`,
`cline`, `together`, `copilot` and `google`.

Set `ZERO_MODEL` alongside an environment provider selection. A separately
configured explicit model can use another route, for example a cross-model
verification call.
Use the selected provider's own credentials and account-supported model ID.

```bash
env ZERO_SELECTED_PROVIDER=deepseek ZERO_MODEL=deepseek-flash \
  0 scan web --target https://example.com --scope ./scope.json --mode web --runtime api
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
0 scan web --target https://api.example.com --scope ./scope.json --runtime api --model glm-5.3
0 scan web --target https://api.example.com --scope ./scope.json --runtime api --model qwen3.8-max

# Or use OpenRouter.
export OPENROUTER_API_KEY="sk-or-v1-..."

# Advanced ChatGPT Codex token override; normal setup uses Connections or codex login.
env ZERO_CHATGPT_OAUTH_REFRESH_TOKEN="..." \
  0 scan source ./authorized-repo --runtime api
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
`ZERO_CODEX_AUTH_JSON_PATH`; an account ID comes from `ZERO_CHATGPT_ACCOUNT_ID`
or the same file. The older `ZERO_CHATGPT_AUTH_FILE` is a deprecated alias.

Path precedence for the auth file:
1. `ZERO_CODEX_AUTH_JSON_PATH`.
2. `~/.codex/auth.json` (the default when no override is set).

The CLI bootstrap runs `maybeLoadCodexAuth` at startup, loading the auth file
into `ZERO_CHATGPT_*` env vars if no token is present. A logged-in `codex`
session takes priority over stale `AZURE_OPENAI_API_KEY` / `OPENAI_API_KEY`
left in a dev shell.

In **Connections**, select **ChatGPT Codex** and follow the device sign-in
instructions. The CLI flow uses `codex login --device-auth` and reloads the auth
file after success. Choose **OpenAI** for an API-key connection.

The browser refreshes CLI-imported authentication when resolving connections;
explicit environment credentials still win. Existing conversations retain their
selected connection. Missing or malformed auth files do not configure a provider.

Select **Daybreak Blue** separately from the model in the console, or pass
`--runtime api --provider chatgpt-codex --cyber-access-program daybreak_blue`
to `0 scan source` or `0 scan web`. This uses your existing ChatGPT/Codex OAuth connection;
public OpenAI API keys use `--provider openai`. The selector requires a canonical
provider endpoint and approved account access. Requested access and provider
confirmation are recorded separately. See [access-program configuration](/configuration/#cyber-access-programs-and-daybreak).

## Console credential store

Use **Connections** to add or inspect accounts and **Models** to choose a model.
The conversation model menu changes the current chat while it is idle. Successful
explicit choices are remembered for the same connection; CLI/environment choices
take precedence. Existing conversations keep their captured connection until
explicitly reconnected.

Saved credentials are plaintext in the [state directory](/configuration/#state-directory)
(`~/.0/` by default), protected by file permissions. Keep them out of source
control and issue reports. A usable environment credential takes precedence
over that provider's stored account; a blank value allows the saved account to load.

Subscription choices come from the signed-in account. API model discovery uses
the configured endpoint and credentials; pricing metadata can come from a public
catalog. See [Model picker](/console/#model-picker) for the browser controls.

### Other browser and subscription connections

Connections also provides these browser/device flows:

| Connection | Authentication behavior |
| --- | --- |
| xAI | API key, or device sign-in with `ZERO_XAI_OAUTH_CLIENT_ID` registered for 0 |
| Kimi | API key by default. Browser device sign-in is offered only when `ZERO_KIMI_OAUTH_CLIENT_ID` is explicitly configured with a client registered for 0; restart after configuring it. Existing saved accounts remain usable. |
| GitHub Copilot | New browser sign-in requires `ZERO_COPILOT_OAUTH_CLIENT_ID` registered for 0 with Copilot service access. GitHub device-code token, used for the Copilot endpoint; an eligible Copilot account and model access are still required |
| Google Gemini Code Assist | New browser sign-in requires `ZERO_GOOGLE_OAUTH_CLIENT_ID` registered for 0 and Code Assist access (`ZERO_GOOGLE_OAUTH_CLIENT_SECRET` if required). Google browser PKCE flow with loopback callback; stores OAuth access/refresh tokens; resolves project/tier at request time |
| OpenRouter | Browser PKCE flow provisions an API key; it is not an unlimited subscription |
| ChatGPT Codex | Official `codex login --device-auth`; tokens remain in the Codex auth file |

Qwen uses an API key; upstream Qwen Code discontinued OAuth on April 15, 2026
([official migration guidance](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/auth.md)).
Set `QWEN_API_KEY` and `QWEN_BASE_URL` for the **same product and region** shown
in your account: QwenCloud, Alibaba Model Studio PAYG, Coding Plan and Token Plan
credentials are not interchangeable. Copy the exact endpoint from that product's
setup instructions; 0 does not infer your region or migrate existing keys.

Kimi, xAI, Copilot and Google browser sign-in require a client registered for 0.
Configure the listed `ZERO_*_OAUTH_CLIENT_ID` before starting the app. Without
registration, use an API key where supported; Google Code Assist and Copilot are
OAuth-only here. Existing saved accounts remain usable.

The console account store is plaintext and protected by file permissions.
For portable automation, provide the required credentials in the environment
rather than relying on another shell's connection state.

### Jev credentials are separate

Jev assistance is off until `ZERO_JEV_FEATURES` explicitly names a workflow.
It does not reuse your chat-provider selection: Vercel needs
`AI_GATEWAY_API_KEY`, and the Cloud adapter needs both `ZERO_JEV_CLOUD_TOKEN`
and `ZERO_JEV_CLOUD_URL`. Both reach the same upstream model; Cloud routes
through the orchestrator so usage bills your workspace credits, while Vercel
calls the gateway directly with your own key.
See [opt-in Jev assistance](/configuration/#opt-in-jev-assistance) before
enabling data egress and [separate budgets](/budget-management/#jev-advisory-budgets).

## When to use OpenRouter

Use OpenRouter for model families with no direct provider credential. It also
serves as fallback when a `claude-*` model is requested without
`ANTHROPIC_API_KEY`: the runtime checks for `OPENROUTER_API_KEY` before giving
up.

## Provider failover

`ZERO_LLM_FALLBACK` configures an ordered chain of backup providers when the
primary exhausts its retry budget, hits a plan-quota limit, or returns a
classified policy refusal:

```bash
env ZERO_LLM_FALLBACK=deepseek:deepseek-flash,azure:gpt-5-deployment \
  0 scan source ./authorized-repo --runtime api
```

Each entry is `<providerId>:<model>`, comma-separated. The runtime advances
through eligible routes sequentially and skips entries without the required
credentials. Supported IDs are `openrouter`, `anthropic`, `openai`, `azure`,
`deepseek`, `chatgpt-codex`, `z-ai`, `kimi`, `qwen`, `xai`, `opencode`,
`cline`, `together`, `copilot` and `google`. An explicit cyber-access-program request keeps
its selected provider and disables this failover chain.

## Azure OpenAI configuration

The model picker lists deployment names from the selected Azure resource, not
OpenAI's model catalog. Discovery uses an existing Azure CLI sign-in with read
access to the resource and its deployments, matching the configured endpoint to
that resource. It never starts a login or changes deployments. An inference API
key alone cannot enumerate resource deployments; if Azure CLI/resource access is
unavailable, configure the exact deployment ID manually in Connections instead.
Providers without a supported account-scoped listing API report discovery as
unavailable rather than offering their public catalog as selectable models.

Configure an Azure API key, endpoint and actual deployment ID. The most
repeatable setup supplies all three and pins the provider:

```bash
export AZURE_OPENAI_API_KEY="your-azure-key"
export AZURE_OPENAI_BASE_URL="https://your-resource.openai.azure.com/openai/v1"
export AZURE_OPENAI_WIRE_API="responses"
env ZERO_SELECTED_PROVIDER=azure ZERO_MODEL="your-deployment-id" \
  0 scan source ./authorized-repo --runtime api --cost-ceiling 5
```

| Setting | Resolution |
| --- | --- |
| API key | `AZURE_OPENAI_API_KEY` (or explicit runtime API key with Azure selected) |
| Endpoint, unpinned detection | `AZURE_OPENAI_BASE_URL`, then `OPENAI_BASE_URL`, then the Azure provider section of `~/.codex/config.toml` |
| Endpoint, explicit pin / fallback entry | `AZURE_OPENAI_BASE_URL`, then `OPENAI_BASE_URL`, then the Azure provider section of `~/.codex/config.toml` |
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

Cost estimates can differ by deployment, region, context size and provider
billing. Reconcile them against Azure Cost Management; see
[cost estimate limits](/budget-management/#interpreting-cost-estimates).

## Alternative: CLI runtimes

To skip API keys entirely, use CLI runtimes. Claude runs live scans through its
subscription loop; Codex and Gemini are source-review oriented:

```bash
# Use Claude Code CLI for an authorized live target
0 scan web --target https://api.example.com/chat --scope ./scope.json --runtime claude
# Use Codex CLI for source review
0 scan source ./my-repo --runtime codex

# Use Gemini CLI
0 scan source ./my-repo --runtime gemini
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
- Runtime version compatibility. A source checkout requires Node.js 24+; the native installer supplies a Bun-based binary.
- **API provider** status: `configured` (credential found), `bad` (configured but
  unusable), or `missing` (no credential).
- **CLI runtimes** found on `PATH` (claude, codex, gemini).
- Configuration errors when the API runtime is set up but cannot be used.

`doctor` prints the same scriptable diagnostics under Node and the standalone binary.
