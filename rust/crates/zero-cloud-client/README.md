# Read-only cloud metadata client

`CloudClient::new(host, token, timeout, max_bytes)` accepts an explicit endpoint
and in-memory bearer token. It implements no `Debug` or `Serialize`, reads no
credential files, performs no login, and does not configure the inference engine.
Only four GET methods exist: `ping_health`, `inference_models`,
`inference_account`, and `inference_usage`; each takes a cancellation token.

Routes and data contracts follow `packages/core/src/cloud/client.ts`:

- Canonical `cloud.0sec.ai` and `cloud.0.security` hosts use `/api/health`;
  other hosts use `/health`. Host path prefixes are preserved.
- Catalog: `/api/inference/v1/models`. Typed entries validate object markers,
  nonempty identifiers, unique IDs, wire API, positive context/output limits and
  nonnegative numeric prices. Prices remain `serde_json::Number`; there is no
  currency-unit conversion, rounding into engine rates or guessed pricing.
- Account: `/api/inference/account`. Missing/malformed credits become `None`.
  Percent is accepted only if service-supplied and valid with a positive grant
  and remaining <= granted. Missing percentages stay unavailable, even when
  remaining/granted could produce a ratio. Reset times follow the TypeScript
  safe integer/date bound. The account's USD marker and nonnegative balance are
  additionally validated; the client does not reconstruct a quota.
- Usage: `/api/inference/usage`. Request metadata remains object records; this
  client does not add prompt/response content or invent a detailed usage schema.

HTTPS is required except HTTP loopback (`localhost` or loopback IP). URL
credentials, queries/fragments, empty tokens and invalid header bytes fail with
fixed errors. Redirects and reqwest retries are explicitly disabled. Calls have
an absolute deadline (up to one hour) and aggregate body limit (1 KiB–16 MiB),
including non-success bodies. Cancellation covers connecting and reading.
Authorization is a sensitive header; User-Agent is `0sec-cli/<crate version>`.

401 and 403 are distinct typed errors. Other HTTP errors preserve only status
and these nested `error.code` values: `inference_disabled`,
`provider_unavailable`, `billing_unavailable`, `insufficient_funds`. Unknown
codes, gateway messages, URLs, tokens and network exception details are never
copied into errors. Arbitrary server fields may remain in successful usage
records; callers must treat successful server data as untrusted before display.
This deliberately tightens the TypeScript client's unrestricted error-code echo.

No uploads, account mutations, live-account requests or paid inference are
implemented. Tests use localhost listeners for routes/headers, nested errors,
normalization, actual redirect isolation, no retries, byte limits, cancellation
and deadlines. Run `cargo test -p zero-cloud-client --locked`.
