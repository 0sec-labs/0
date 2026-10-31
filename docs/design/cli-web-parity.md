# CLI and web control parity

> Status: 2026-10-28. Source-built local CLI and isolated fixtures were tested. This is not a claim that every installed executable or deployed cloud service has these changes.

The local `0` engine and hosted `0cloud` CLI are separate products. Sharing a
backend does not itself create a CLI command for every browser feature.

## Local engine

| Feature | Dedicated CLI | Backend API client |
| --- | --- | --- |
| Session discovery/create/read/send/cancel/events/resume/decisions | `sessions`, headless `console` | `0 api /api/console/...` |
| Search, saved-session archive/delete and configuration | Partial dedicated coverage | Existing admitted console HTTP routes |
| Workflow templates/definitions/runs | `workflow`, `runs`; definition authoring incomplete | Existing workflow HTTP routes |
| Schedules | No dedicated command family | Existing workflow-trigger HTTP routes; activation review still applies |
| Skills | Plugin/hackstore operations are not a full skills editor | Existing skills HTTP routes |
| Memory library | `learning status/process/evolve` only | Existing learning read/status/export/import routes |
| Findings | Existing findings and investigation commands | Existing findings/impact HTTP routes |
| Provider/runtime/settings controls | `config`, workbench and selected connection flags | Admitted settings/connection HTTP routes |
| Browser appearance | Browser-local state | Settings → Appearance; not a backend API setting |
| OAuth/device approval | Launch/status may be automated | Person completes browser/provider approval |
| Binary downloads and event streaming | Resource-specific commands where implemented | Generic `0 api` currently supports bounded JSON/text only |

`0 api` reuses BackendConnectionRegistry: explicit selected engine, bearer token
from environment, HTTPS or loopback HTTP, engine identity/capability checks, path
admission, bounded request/response data and no redirects. Server authorization
remains authoritative. It is not an arbitrary curl replacement or a claim of
complete typed-command parity.

Verified tests cover command discovery, JSON output, isolated configuration and
history, authenticated session control, workflow templates, transport failures,
permission and identity failures, and a real local MCP capability handshake.
No paid model calls, external target tests, live cloud writes or actual OAuth
connections were used in this qualification. See `scripts/cli-process-smoke.test.mjs`,
`scripts/smoke-api-engine.mjs`, and the API command/backend suites.

## Hosted cloud CLI

The shared checkout was CLI 0.6.1; the current-main worktree tested CLI 0.7.1.
The latter includes `onboard` and `setup-prompt`. Typed commands cover most
workspace, codebase, automation, security-test, findings, settings and integration
operations. GitHub/provider authorization and card/payment changes still need a
person's browser flow.

`onboard --status` exit zero means the state report succeeded; inspect states such
as `not_signed_in` or `needs_github` before treating the agent as ready. Dry runs
can perform read/validation HTTP requests; they do not universally mean no I/O.

A JSON-error/logout fix is prepared on `fix/cli-json-errors-20261028` in an
isolated cloud worktree. It has not been merged, pushed or deployed. Its tests
verify real CLI processes against a loopback mock and isolated credentials;
current installed/deployed versions must not be assumed fixed.

## Remaining qualification

- Add or test typed wrappers where they improve discoverability over generic API calls.
- Test all session-worker, skills, memory import/status and settings write contracts.
- Qualify binary exports, event streams and long-running reconnect/cancellation separately.
- Run live-provider/cloud qualification only with explicit target/account/budget scope.
- Publish/install the qualified artifacts before claiming the running release has full coverage.
