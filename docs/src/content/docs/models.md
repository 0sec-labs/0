---
title: Models and keys
description: Connect a model provider, choose models per role and control how 0 routes model calls.
---

0 uses your own model provider. Connect one in the browser or with an environment variable, then pick a model.

## Connect in the browser

1. Run `0` and open **Settings → Connections**.
2. Pick a provider. Paste an API key or follow its sign-in flow.
3. A connected provider gets its default model automatically. To change it, open **Settings → Models** and pick a **Default model**, or pick a model in a mission with the model picker.

The model list comes from your connections. **Models** lists every model they serve and flags a connection that needs attention. On **Connections**, you can turn off single models of a connection. Public catalogs add price and context data but do not grant access; a listed model can still be unavailable to your account.

## Connect from a shell

Export a provider key, then run any command:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
0 scan source ./your-repo --runtime api --depth quick --cost-ceiling 2
```

| Provider | Environment |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| ChatGPT Codex | `codex login`, or `ZERO_CHATGPT_ACCESS_TOKEN` / `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, plus endpoint and deployment ([details](#azure-openai)) |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Z.ai GLM | `Z_AI_API_KEY` |
| Moonshot Kimi | `KIMI_API_KEY` |
| Alibaba Qwen | `QWEN_API_KEY` and `QWEN_BASE_URL` |
| xAI Grok | `XAI_API_KEY` |
| OpenCode Zen | `OPENCODE_API_KEY` (`OPENCODE_BASE_URL` to change endpoint) |
| Together AI | `TOGETHER_API_KEY` ([details](#together-ai)) |

Pass `ZERO_*` variables with `env`, for example `env ZERO_CHATGPT_OAUTH_REFRESH_TOKEN=... 0 doctor`.

Check what 0 found:

```bash
0 doctor
```

<span id="0-doctor--credential-readiness"></span>
`0 doctor` prints the CLI version, runtime, platform and Node.js check, then the API provider status: `configured`, `bad` (found but unusable, with the reason) or `missing`. It also lists `claude`, `codex` and `gemini` CLIs found on `PATH`. It checks local configuration only. The first model request proves the key, model access and quota.

## Choose a model

- **Browser**: the model picker in a mission changes that mission's model while it is idle. **Settings → Models → Default model** sets the default for new missions. Existing missions keep their connection until you change it.
- **CLI**: pass `--model <id>` or set `ZERO_MODEL`. `--model` wins.

Use an exact model ID your account supports:

```bash
env ZERO_SELECTED_PROVIDER=openai ZERO_MODEL=<model-id> \
  0 scan source ./authorized-repo --runtime api
```

Agent workflows need a model that supports tool calling.

<span id="multi-model-role-routing"></span>
## Role models

0 can use different models for different jobs. The roles are `discovery`, `attack`, `verify`, `report`, `audit` and `review`.

In the browser, open **Models → Advanced**:

- **Use one model for everything** sends every role to the main model.
- **Pick models per task automatically** lets 0 choose among models your connection can reach.
- Each role has its own model select. **Auto** follows the main model or the automatic choice.

On `0 scan web`, use `--task-model <role=model>` (repeatable) for `discovery`, `attack`, `verify` and `report`, or `--single-model` to use one model throughout.

Role models stay on the parent's connection. Child agents use the same provider, endpoint and credentials, and do not inherit a failover chain. Choose models that same account serves. Connecting a second provider does not make roles cross accounts. Role changes apply after the current step finishes. Role routing is not failover and does not add an independent verification stage on its own.

## Custom and local providers

<span id="custom-ai-providers-including-9router"></span>
Any OpenAI-compatible Chat Completions server works, local or remote.

In **Connections**, choose **OpenAI / Custom AI Provider**. Enter the base URL with its version path (for example `http://localhost:20128/v1`), the **Custom model ID** and the API key. HTTP and HTTPS both work. The model does not need to be in any catalog.

In a shell:

```bash
export OPENAI_API_KEY="your-provider-key"
export OPENAI_BASE_URL="http://localhost:20128/v1"
export OPENAI_MODEL="your-provider/model-id"
export ZERO_SELECTED_PROVIDER="openai"
0
```

0 appends `/chat/completions` to the base URL. Set `OPENAI_WIRE_API=responses` for servers that need the Responses API. Exported values override saved connection settings, and an explicit model choice overrides `OPENAI_MODEL`.

For OpenCode Go, use its published base URL, such as `https://opencode.ai/inference/go/openai/v1`.

### Ollama for source review

`scan source` can call a local Ollama server directly:

```bash
OLLAMA_HOST=http://localhost:11434 \
  0 scan source ./authorized-repo --runtime ollama --model gemma4:27b
```

The model comes from `--model`, then `ZERO_OLLAMA_MODEL`, then `gemma4:27b`. `OLLAMA_HOST` defaults to `http://localhost:11434`. Pull a model that supports tool calling first. A remote `OLLAMA_HOST` receives your source context.

## ChatGPT Codex

<span id="chatgpt-codex-authentication"></span>
In **Connections**, select **ChatGPT Codex** and follow the device sign-in. It runs `codex login --device-auth` and reloads the auth file when done.

From a shell, run `codex login`. 0 reads tokens from `~/.codex/auth.json` at startup when no `ZERO_CHATGPT_*` token is set. A signed-in Codex session takes priority over stale `OPENAI_API_KEY` or `AZURE_OPENAI_API_KEY` values in your shell.

| Variable | Use |
| --- | --- |
| `ZERO_CODEX_AUTH_JSON_PATH` | Read a different auth file. `ZERO_CHATGPT_AUTH_FILE` is a deprecated alias. |
| `ZERO_CHATGPT_ACCESS_TOKEN`, `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN` | Supply tokens directly. The access token is read first. |
| `ZERO_CHATGPT_ACCOUNT_ID` | Set the account ID. Otherwise it comes from the auth file. |

Codex uses its own auth file, not 0's credential store. It rejects a generic `--api-key`. Choose **OpenAI** for an API-key connection.

## Provider notes

### Azure OpenAI

<span id="azure-openai-configuration"></span>

Supply the key, the endpoint and the deployment ID, and pin the provider:

```bash
export AZURE_OPENAI_API_KEY="your-azure-key"
export AZURE_OPENAI_BASE_URL="https://your-resource.openai.azure.com/openai/v1"
export AZURE_OPENAI_WIRE_API="responses"
env ZERO_SELECTED_PROVIDER=azure ZERO_MODEL="your-deployment-id" \
  0 scan source ./authorized-repo --runtime api --cost-ceiling 5
```

| Setting | Resolution |
| --- | --- |
| Endpoint | `AZURE_OPENAI_BASE_URL`, then `OPENAI_BASE_URL`, then the Azure section of `~/.codex/config.toml` |
| Model | `--model`, then `ZERO_MODEL`. Without a pin, `AZURE_OPENAI_MODEL` or an Azure-backed Codex config model also works. |
| Wire | `AZURE_OPENAI_WIRE_API`: `chat_completions` (default) or `responses` |

Include `/openai/v1` in a Responses base URL. The model picker lists deployments from your Azure resource through an existing Azure CLI sign-in; it never starts a login. With a key alone, enter the deployment ID by hand. 0 probes the endpoint once for its region; that is a diagnostic, not a residency guarantee.

### Together AI

Connect **Together AI** or export `TOGETHER_API_KEY`. The default endpoint is `https://api.together.ai/v1`; set `TOGETHER_BASE_URL` to change it.

Together model IDs look like other providers' IDs (`Qwen/...`, `deepseek-ai/...`), so 0 never routes to Together by model name. Select it explicitly:

```bash
env ZERO_SELECTED_PROVIDER=together ZERO_MODEL=openai/gpt-oss-120b \
  0 scan source ./authorized-repo --runtime api
# or, with no provider pin:
0 scan source ./authorized-repo --runtime api --model together/openai/gpt-oss-120b
```

The `together/` prefix is removed once before the request. The default model is `openai/gpt-oss-120b`. The picker lists chat models with published prices; set `TOGETHER_MODEL_LIST=all` to list every chat model your key can see. Unlisted IDs, including dedicated endpoints, still work with `--model`.

### Alibaba Qwen

Set `QWEN_API_KEY` and `QWEN_BASE_URL` for the same product and region shown in your account. QwenCloud, Model Studio, Coding Plan and Token Plan keys are not interchangeable, and 0 does not infer the region. Qwen OAuth is discontinued upstream.

### OpenRouter, xAI and Kimi sign-in

<span id="free-openrouter-model"></span>

- **OpenRouter**: the browser sign-in provisions an API key for you. When OpenRouter is the selected provider, `--model free` maps to `nvidia/nemotron-3-super-120b-a12b:free`.
- **xAI** and **Kimi**: browser sign-in needs a client registered for 0 in `ZERO_XAI_OAUTH_CLIENT_ID` or `ZERO_KIMI_OAUTH_CLIENT_ID` before the app starts. Otherwise use an API key.

OpenAI, OpenRouter, xAI and Azure accept `OPENAI_WIRE_API`, `OPENROUTER_WIRE_API`, `XAI_WIRE_API` and `AZURE_OPENAI_WIRE_API` set to `chat_completions` or `responses`.

## How 0 picks a provider

With several keys set, 0 resolves the provider in this order:

1. **A pin.** `ZERO_SELECTED_PROVIDER` selects the provider outright. Set `ZERO_MODEL` with it.
2. **The model name.** `--model` or `ZERO_MODEL` routes by prefix when that provider has a key.
3. **Ambient priority.** Otherwise the first configured key in the list below wins.

<span id="provider-pinning"></span>
### Pin a provider

`ZERO_SELECTED_PROVIDER` accepts `openrouter`, `anthropic`, `openai`, `azure`, `deepseek`, `chatgpt-codex`, `z-ai`, `kimi`, `qwen`, `xai`, `opencode` and `together`.

```bash
env ZERO_SELECTED_PROVIDER=deepseek ZERO_MODEL=deepseek-flash \
  0 scan web --target https://example.com --scope ./scope.json --runtime api
```

Pin when you need a predictable bill, especially with Azure deployment names. `ZERO_FORCE_PROVIDER` is a benchmark override; setting it to a different value than `ZERO_SELECTED_PROVIDER` is an error.

<span id="model-routing"></span>
### Routing by model name

| Model ID | Provider |
| --- | --- |
| `together/<org>/<model>` | Together AI (prefix removed) |
| `openrouter/*` | OpenRouter |
| `glm-*`, `z-ai/*`, IDs containing `glm` | Z.ai GLM |
| `qwen*` | Alibaba Qwen |
| `k3*`, `kimi*` | Moonshot Kimi |
| `grok*`, `xai/*`, `x-ai/*` | xAI Grok |
| `opencode/*`, `muse-spark*`, `mimo*`, `ling*`, `big-pickle`, `nemotron*`, `minimax*` | OpenCode Zen |
| `gpt-*`, `o1` to `o4` | ChatGPT Codex when signed in, else OpenAI |
| `claude*`, `anthropic/*`, IDs containing `sonnet`, `opus` or `haiku` | Anthropic, else OpenRouter |
| Exact `deepseek-flash`, `deepseek-v4-flash` | DeepSeek |
| Known Azure Foundry deployment IDs | Azure |

A match without that provider's key falls through to ambient priority. These are routing rules, not an availability check.

### Ambient priority

1. ChatGPT Codex (`ZERO_CHATGPT_*` tokens or `~/.codex/auth.json`)
2. DeepSeek
3. OpenRouter
4. Azure OpenAI
5. OpenAI
6. Z.ai GLM
7. Moonshot Kimi
8. Alibaba Qwen
9. xAI Grok
10. OpenCode Zen
11. Anthropic
12. Together AI

An explicit `--api-key` without a pin picks by shape: `sk-or-` selects OpenRouter, `sk-ant-` selects Anthropic, and anything else selects OpenAI-compatible access. Prefer environment variables; command-line secrets end up in shell history and process lists.

<span id="provider-failover"></span>
## Failover

`ZERO_LLM_FALLBACK` lists backup routes for when the primary runs out of retries or hits a plan quota:

```bash
env ZERO_LLM_FALLBACK=deepseek:deepseek-flash,azure:gpt-5-deployment \
  0 scan source ./authorized-repo --runtime api
```

Each entry is `<provider>:<model>`, comma-separated, tried in order. Entries without credentials (or, for Azure, without an endpoint) are skipped. Failover changes who receives your context and who bills you. A cyber access program request disables failover.

## Advanced settings

| Variable | Default | Effect |
| --- | --- | --- |
| `ZERO_RUNTIME` | `auto` | Provider client. `auto` uses the pi-ai layer for the routes it serves and the built-in client for the rest. `legacy` always uses the built-in client. `pi-ai` forces pi-ai and fails on routes it cannot serve. |
| `ZERO_RUNTIME_TRACE` | unset | `1` prints the chosen client, provider and model to stderr. |
| `ZERO_MAX_COMPLETION_TOKENS` | `8192` | Completion tokens requested per call. Positive integer; values above `131072` are clamped. Very small values truncate tool calls. |

If a provider misbehaves under `auto`, set `ZERO_RUNTIME=legacy` and report it.

## CLI runtimes

`--runtime` chooses how a scan reaches a model. The default is `auto`.

| Runtime | Uses |
| --- | --- |
| `api` | Direct HTTP calls with the provider rules above. |
| `claude` | The installed, signed-in Claude Code CLI. |
| `codex` | Source reviews keep 0's own tool boundary. Live scans use the ChatGPT Codex provider directly. |
| `gemini` | The installed, signed-in Gemini CLI, for source work. |
| `ollama` | A local Ollama server, for `scan source`. |

```bash
0 scan web --target https://api.example.com --scope ./scope.json --runtime claude
0 scan source ./my-repo --runtime codex
```

Use `--runtime api` when you want the provider rules on this page instead of `auto`. External CLIs make their own network calls, which 0 does not control.

<span id="cyber-access-programs-and-daybreak"></span>
## Cyber access programs

OpenAI's Daybreak programs need an explicit request. A model name alone does not select one.

- **Browser**: use the **Daybreak** control beside the model settings. **Automatic** clears the request.
- **CLI**: `0 scan source` and `0 scan web` accept `--cyber-access-program standard|daybreak_blue|daybreak_red`. It requires `--runtime api` and `--provider openai` or `--provider chatgpt-codex`.

```bash
# OpenAI API project with approved access:
env OPENAI_WIRE_API=responses \
  0 scan source ./authorized-repo --runtime api --provider openai \
  --model <approved-model> --cyber-access-program daybreak_blue

# Existing ChatGPT/Codex sign-in:
0 scan source ./authorized-repo --runtime api --provider chatgpt-codex \
  --model <model> --cyber-access-program daybreak_blue
```

The flag requests access; it does not grant it. Reports keep the requested program separate from what the provider confirmed. Program-bound calls never fall back to another provider. Do not pass `--api-key` with ChatGPT sign-in.

<span id="console-credential-store"></span>
## Where credentials live

Keys saved in **Connections** are stored in plaintext at `~/.0/credentials.json`, with `0600` file and `0700` folder permissions. Keep that file out of source control and bug reports. A nonblank environment variable wins over the saved key for that provider. For CI and other automation, pass credentials in the environment.

## Limits

- Billing, model access and rate limits belong to your provider account.
- Shown prices are estimates. Unknown prices are unknown, not zero, so a cost ceiling cannot bound that model. See [Costs and budgets](/budgets/).
- A model connection does not authorize a target. See [Scope and authorization](/scope/).
