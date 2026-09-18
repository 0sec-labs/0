# Read-only cloud metadata client

`CloudClient::new(host, token, timeout, max_bytes)` accepts an explicit endpoint
and in-memory bearer token. It implements no `Debug` or `Serialize`, reads no
credential files, performs no login, and does not configure the inference engine.
The GET methods are `ping_health`, `inference_models`, `inference_account`, and
`inference_usage`; each takes a cancellation token. `hosted_route(model, cancel)`
fetches the catalog once and compiles an explicitly selected model route.

Routes and data contracts follow `packages/core/src/cloud/client.ts`:

- Canonical `cloud.0sec.ai` and `cloud.0.security` hosts use `/api/health`;
  other hosts use `/health`. Host path prefixes are preserved.
- Catalog: `/api/inference/v1/models`. Typed entries validate object markers,
  nonempty identifiers, unique IDs, wire API, positive context/output limits and
  nonnegative numeric prices. Catalog prices retain bounded JSON number lexemes in `ExactPrice` values.
  The metadata response does not guess pricing or configure an inference client.
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

## Hosted route selection

`hosted_route(model, cancel)` requires the exact hosted catalog ID; there is no
default model, upstream-model substitution, or automatic inference call.
`select_hosted_route(catalog, model)` performs the same selection on an already
fetched catalog without network effects. The compiler checks every catalog row,
including unselected rows, bounds the catalog to 1,024 entries, and rejects
duplicate IDs, invalid metadata/limits, or prices that native integer accounting
cannot represent. The endpoint preserves the configured host's path prefix and
uses `/api/inference/v1/responses` or `/api/inference/v1/chat/completions` according
to the selected wire API. Catalog provider/upstream fields are metadata only.

`HostedRoute` contains an endpoint, selected model, wire API, output-token cap,
integer `Rates`, and a credential-free `HostedCatalogPin`. USD-per-million prices
are converted to micro-USD-per-million using decimal digits and checked integer
arithmetic. Local `RawValue` parsing preserves decimal lexemes before conversion;
fractional micro-USD prices and `u64` overflow are rejected without rounding.
Equivalent decimal spellings normalize to one selected-model metadata hash.
Pin metadata stores its three USD prices as canonical decimal **strings**; this
keeps exact prices through ordinary JSON value/database roundtrips. Shared JSON
number decoding remains unchanged. Catalog serialization directly to JSON keeps
prices as numbers; do not roundtrip raw catalog prices through a generic JSON
value before compiling a route.
No timestamp enters the pin. Host, model metadata, price, and route changes alter
its serialized identity; unrelated valid catalog rows do not.

`validate_hosted_pin(pin)` purely recompiles its normalized metadata, route,
limits, currency, rates, and SHA-256 identity. This checks internal consistency,
not server authenticity or freshness. The caller must obtain the catalog from
its explicitly trusted host and bind the pin to its provider client and durable
request. Neither route nor pin contains the client's authorization header.

## Hosted browser login transport

`LoginSession::new(host, LoginOptions::default())` implements the existing hosted
browser-session flow in `packages/cli/src/commands/auth.ts`, not an OAuth device
code protocol. Construction makes no requests. `browser_url()` is the explicit
user-facing URL `<host>/cli-auth?session=ID`; `wait(cancellation)` consumes the
session and polls unauthenticated `GET <host>/cli-auth/sessions/ID`. The ID is nine
cryptographically random bytes encoded into 12 base64url characters, matching the
legacy client's 72-bit entropy and shape. No server implementation or independent
server TTL contract is present in this checkout.

Default limits match the legacy client: 150 attempts, a two-second wait before
each request, a five-minute overall deadline, and ten seconds per request. The
native overall deadline starts at session construction, including time spent
showing/opening the browser URL. Configurable limits are bounded to 150 attempts,
30-second intervals, five minutes overall, ten seconds/request and 64 KiB bodies;
interval and timeouts must be positive. HTTP 202/204/404 and JSON `status: pending`
continue polling. HTTP 410 or JSON `status: expired` stops as expired. A ready
response accepts `token` or the legacy `access_token` alias; an absent status is
accepted for compatible receivers. A token paired with any non-ready explicit
status is rejected. Tokens must be valid bounded header values without internal
whitespace or controls. No response-supplied polling interval is interpreted.

Only pending responses are polled again. Redirects, rate limits (429), server
errors and malformed/oversized responses are terminal; `recoverable()` reports
whether a caller may offer a separate new login. Retry-After is not automatically
followed. Unlike the legacy client's transport-error continuation, native network
errors and per-request timeouts stop immediately. There are no automatic HTTP
retries. Hosts require HTTPS except loopback HTTP and cannot contain URL
credentials, query or fragment. Errors never include request URLs, session IDs,
response bodies or credentials.

`LoginCredential` exposes its host and `expose_token()` only through explicit
accessors and implements neither Debug nor Serialize; the same applies to the
session. This library never opens a browser, reads or writes credentials, invokes
shells, claims inference availability, or calls a live login service in tests.
Callers must deliberately display the login URL and handle the returned credential
privately. The credential remains an ordinary in-memory string, without a claim
of memory zeroization. Localhost tests cover the actual routes, pending/ready and
expiry, legacy aliases, early-token rejection, rate/outage termination, redirects,
limits, cancellation, and secret-free diagnostics.
