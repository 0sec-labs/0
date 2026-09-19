# Native provider parity audit (2026-09-19)

This audit records remaining migration scope; it does not claim provider parity.

| Legacy surface | Native state and next boundary |
| --- | --- |
| Cloud browser sign-in | Native `hosted login` already polls the browser session and writes private credentials. `hosted health/models/account/usage` and legacy environment/file resolution already exist. Do not count another browser-login wrapper as a new backend. |
| `auth logout` / manual token | Native `hosted` (alias `auth`) now supports offline manual import with `login --token-from-env NAME`, `status` as a health alias, and idempotent logout of both legacy stores (or one explicit file). Import uses atomic private `cloud.env` persistence; unlike legacy login it does not write the secondary `.0cloud` credentials file. Environment tokens and remote sessions survive local logout. See `HOSTED-CREDENTIALS.md`. |
| `connect` | Legacy verifies cloud auth, detects repository tests, creates a managed scan, then creates a recurring schedule. This is fresh cloud execution/scheduling authority, not merely local authentication; port with the cloud admission lane. |
| Claude CLI native loop | `cli-native.ts` implements multi-turn only for Claude, inherits process environment/cwd, uses retained subprocess sessions and ignores its supplied tool definitions. It cannot simply become a native provider without an isolated subprocess/tool-authority contract. |
| Codex/Gemini subprocess loop | The same legacy adapter explicitly rejects these multi-turn routes; registry descriptions alone are not implementation proof. |
| Direct ChatGPT-Codex route | Legacy `llm-api.ts` uses a distinct subscription endpoint, account headers, OAuth refresh rotation and credential-file compare-before-write. Native Responses API support alone does not implement that route. Upstream wire and managed-auth requirements need validation before a native port. |
| Ollama | Legacy has an actual `/api/chat` implementation with NDJSON streaming, local tools and token counts. This slice adds an explicit native `ollama_chat` wire adapter, strict assistant replay, ordered tool correlation, and final-token accounting. Local HTTP fixtures establish the contract, not live model qualification. |

Primary repository evidence is `packages/cli/src/commands/{auth,connect}.ts`,
`packages/core/src/runtime/{cli-native,llm-api,ollama}.ts`, and
`rust/crates/zero-cli/src/{hosted,hosted_login,credentials,providers}.rs`.
The legacy Ollama continuation flattens assistant tool calls into text and permits
malformed argument strings as `_raw`; those behaviors must not be copied as tool
authority. Native continuation should retain the actual assistant wire message,
correlate ordered tool results, and reject malformed arguments.

Official OpenAI authentication documentation was fetched on 2026-09-19. It
confirms file/keyring/auto/ephemeral credential stores, automatic refresh for
ChatGPT sessions, and administrator-enforced authentication restrictions. It does
not establish a general-purpose third-party subscription HTTP wire contract.
See [OpenAI authentication](https://learn.chatgpt.com/docs/auth). No user credential
files were read or changed for this audit, and no live provider request was made.

The Ollama port is based on the actual legacy route and the official
[chat API](https://docs.ollama.com/api/chat) and
[tool-calling contract](https://docs.ollama.com/capabilities/tool-calling), fetched
2026-09-19. Tests use local HTTP fixtures; they neither start Ollama nor pull a
model, and cannot establish real model quality or remote server isolation.
