# Explicit stored provider accounts

Native provider profiles can select one account already saved by the legacy TUI
in its version 2 `credentials.json`, without copying the secret into a shell:

```json
{
  "personal": {
    "url": "https://api.openai.com/v1/responses",
    "wire_api": "responses",
    "credential_account": {
      "file": "/absolute/private-directory/credentials.json",
      "provider_id": "openai",
      "account_id": "default"
    },
    "rates": {"input": 1000000, "cached_input": 0, "output": 1000000},
    "timeout_ms": 30000,
    "max_response_bytes": 1048576
  }
}
```

The URL, rates and account are host-selected profile policy. Use the actual rates
for the selected model; these example numbers are not a pricing claim. Supply
this profile with the existing `--providers` option. The selector must name a
file, provider and account explicitly. The store's active account pointer is
ignored. No home-directory discovery, account fallback, migration, file write,
process environment mutation or token refresh occurs. Selecting both
`api_key_env` and `credential_account` is an error. Existing environment-only and
Entra profiles retain their behavior.

Supported API-key records and required wires are:

| Store provider | Native authentication | Wire |
| --- | --- | --- |
| `openai` | `wire_default` (default) | `responses` or `chat_completions` |
| `anthropic` | `wire_default` | `anthropic_messages` |
| `azure` | `azure_api_key` | `responses` or `chat_completions` |
| `deepseek`, `openrouter`, `z-ai`, `kimi`, `qwen`, `xai`, `opencode` | `wire_default` | `chat_completions` |

A `copilot` OAuth account is supported only with `authentication` set to
`github_copilot` and `wire_api` set to `chat_completions`. Its `accessToken` must
be present, and a supplied `expiresAt` must be in the future when loaded. An
absent expiry supports legacy long-lived device tokens. Refresh-only or expired
accounts are rejected; a stored refresh token is never used. Sign in again using
the owning workflow if needed. Google Code Assist and ChatGPT subscription OAuth
accounts are not API keys and are not accepted through this bridge.

The Unix reader opens every path component without following symlinks. The
immediate parent directory must belong to the caller and be owner-only; the file
must be a caller-owned, single-link, regular file with mode 0600, at most 1 MiB.
It checks file metadata and the reopened pathname identity after the bounded
read. Replacement during the read fails rather than silently changing accounts.
The selected token is captured for the current provider client; subsequent store
changes do not rotate an already-loaded client. Explicit retries and provider
request identities otherwise retain their existing behavior.

Local tests use private fixture account stores and the actual native CLI against
loopback inference endpoints. They prove exact account selection, ignored active
and ambient credentials, unchanged stores, fixed error messages, and zero HTTP
requests for expired/missing/mismatched/insecure credentials. Safe-file tests
exercise replacement, symlinks, hard links and permissions. No live account login
or provider call is part of this qualification.
