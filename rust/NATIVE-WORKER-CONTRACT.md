# Native managed HTTP worker: proposed complete next slice

Status: 2026-09-19. Matched producer/consumer implementation contract. The native producer now implements explicit grants, atomic scan binding, retained terminal files and a dedicated marker. Cloud dispatch, durable publication and typed consumer ingestion below remain pending. This is not a deployed managed adapter. No deployment or paid-provider qualification is implied.

## Source pin and actual boundary

Native source: standalone native scan checkpoint. Cloud source: sibling `0cloud` repository at 834111495fd0e13dbceb158dad125ae3095f4630. Relevant inspected cloud files have no working-tree changes. Compared scan-body.ts against the audit pin f3d82724bb556db8b7740b3a5c2e0532cc1e9816: its only change is the memsafety upload content type/capability/hash headers; HTTP final recovery semantics remain unchanged.

Authoritative existing references:
- Native rust/CLOUD-CONSUMER-AUDIT.md and rust/CLOUD-WORKER-DESIGN.md describe distinct file, terminal marker, progress and final ingestion contracts.
- Cloud services/worker-controller/src/runners/scan-body.ts:41 validates findings[] + integer matching summary.totalFindings; :869 reads report file before missing-file-only stdout fallback, publishes through controller CloudSink, then kills guest. A native ScanReport does not satisfy that legacy schema.
- Cloud services/worker-controller/src/cloud-sink.ts:81 posts {report,final:true} to findings. Its retry schedule bounds attempts, not individual fetch duration.
- Cloud services/orchestrator/src/routes/scans.ts:2301 calls completeScanWithReport; :2340 emits terminal completed even on the terminal-row fallback. db.ts:4019 has error guards and a ghost-completion rule based on tool events/cost or report findings. Order-dependent legacy events cannot safely represent native Partial/Unknown.
- Cloud services/orchestrator/src/routes/events.ts:230 treats cost_update as cumulative; :270/:375 treats scan_completed as terminal authority. It must not receive native completion before the new terminal transaction.
- Cloud packages/cloud-contracts/src/enforcement-summary.ts:42 requires numerical blocked requests, peak rate and rate-limit counts. Native ScanHttpUsage currently does not measure all these quantities.
- Cloud services/worker-controller/src/runners/scan-prep.ts:785-845 freezes target scope/rate/deadline and decrypts target auth; secret-crypto.ts:155 supports bearer/header/cookie/basic. Sink capability and target credentials are separate.
- Native zero-cloud-compat/src/lib.rs provides explicit framing and atomic temp-file/sync/rename writing; its current FinalReport/RunOutcome is not the new managed ScanResult schema. Reuse machinery, retain old formats exactly.
- Native zero-http/src/auth.rs:15 extracts/redacts full header values, bearer components, Basic decoded credentials and cookie values. Use that implementation instead of a second sanitizer.

## Smallest complete enabled workflow

Add one explicitly selected managed native scoped-HTTP mode, version `0sec-native-http/v1`. This is distinct from existing http_audit dispatch until both producer and consumer are qualified. Legacy HTTP/repository/hunt/secure/memsafety paths remain unchanged. Do not select native execution merely because 0SEC_* environment variables are present.

The vertical is: controller captures per-dispatch host grant and credential revision -> explicit native worker CLI invokes existing Engine RunScan exactly once -> native retains honest ScanOutcome and report -> controller durably stages terminal bytes -> typed authenticated consumer transaction stores report, disposition and accounting -> UI displays Unverified/Partial/Unknown truthfully.

No second scan engine, synthetic inference, extra account, automatic restart/rescan, new finding verifier, or direct native completion HTTP sink. Source/repository acquisition and scanner parity are separate later work.

## Shared DTOs and local API

Rust wire definitions live in `zero-protocol::managed_scan` and conversion/file helpers in `zero-cloud-compat::managed_scan`. The matched TypeScript contract and golden cross-language fixtures remain to be implemented. Strict unknown-field rejection applies at the producer boundary. The implementation additionally rejects JSON integers outside JavaScript’s exact integer range; the consumer must preserve this constraint.

`ManagedScanGrantV1`:
- contract_version literal, cloud_scan_id UUID, dispatch_id UUID; organization_id is the exact opaque 16–64 character URL-safe cloud tenant ID (including better-auth nanoids and legacy UUID seeds), not a UUID conversion;
- immutable `grant_revision`, absolute `expires_at_ms`, and target auth revision inside the HTTP policy descriptor (absent only for unauthenticated target);
- normalized target, exact scan profile name and ScanProfile, exact normalized HttpProfilePolicy;
- bounded provider route/rate/catalog pins for root and each delegated provider;
- deterministic native command identity `managed-scan:{cloud_scan_id}:{dispatch_id}`;
- credentials are private handles/environment references, never serialized into this public grant.

Keep root scan intent/account identity authoritative. Grant hash is captured as immutable managed binding at the original scan admission (small additive binding, not a new funded account). Exact retry checks the stored command and binding before reading current secrets/profiles; changed dispatch/grant conflicts. Existing admitted native scan replay stays cached and effect-free. Never silently create another database or command when the original run is uncertain.

`ManagedScanTerminalV1`:
- contract_version literal, cloud_scan_id, organization_id, dispatch_id, grant_sha256;
- native scan/session/controller/root/account IDs and intent digest;
- exact ScanOutcome including stop_reason, completeness, close_reason, model charged/reserved, currency, HTTP requests/request bytes/charged bytes/reserved bytes;
- native publication Retained(report digest + bounded typed ScanReport) | ReportTooLarge | Unavailable(reason);
- optional token totals only if derived from the full validated inference ledger;
- fixed security conclusion not_established, verified count zero and vulnerability_reportable false, checked against nested report;
- explicit metric availability for unsupported enforcement counters, not invented zeros.

Outcome alone never establishes a vulnerability. Investigation completed means a retained valid terminal structured review and no unresolved holds; an empty valid review is real work, not an invented finding or a clean-security guarantee. Compact/Unavailable publication cannot be promoted to a full completed report.

Proposed Rust functions in zero-cloud-compat:
- validate_managed_grant(public grant) -> checked public binding; actual secret/header construction remains host loader work.
- managed_terminal(binding, validated ScanSnapshot, optional validated ScanReport) -> ManagedScanTerminalV1.
- write_managed_terminal(path, terminal) -> {file_sha256,bytes}; bounded writer builds exact immutable UTF-8 bytes, then reuses atomic file replacement semantics.

CLI dedicated `managed-http --grant FILE --report FILE` receives an explicit private grant and preselected private DB/report paths. It uses existing RunScan/cancel/read APIs; ordinary standalone scan keeps its current rejection of managed environment. No universal approval step.

## Publication and crash ordering

1. Freeze dispatch identity/grant in controller storage before guest launch; stage only its own provider key and target auth values. Original controller-owned sandbox cancellation/drain remains responsible for process lifetime.
2. Native owns provider/target effects and durable local scan; cancellation writes durable native stop before local token cancellation when graceful shutdown is available. Hard kill yields Unknown/Unavailable, never simulated native Cancelled success.
3. Native validates retained terminal state and atomically replaces a bounded managed terminal file. Proposed full wire ceiling: 9 MiB, accommodating the existing <=8 MiB native report plus a strictly bounded envelope. Compact metadata fallback <=128 KiB. Validate actual size before both allocation and transport; never truncate a complete report.
4. Only after file publication emit one explicit metadata marker, e.g. `0SEC_NATIVE_RESULT=...` with contract, binding, file hash and publication status. New native branch parses this marker; do not route partial exits through hasClean0secResult. File is authoritative. Missing/corrupt file is not rescued by a success marker or prose stdout. A bounded matching whole-envelope stdout fallback is optional and should be omitted in the first version to minimize ambiguity.
5. Controller reads the bounded file, validates binding and shape/hash, and durably stages exact bytes in a publication outbox keyed (scan,dispatch). Stage before guest cleanup. Otherwise controller failure or exhausted retries followed by sandbox kill loses the only report. Outbox also handles controller restart and lost response without resuming target execution.
6. Controller alone posts exact staged bytes to proposed `POST /scans/:id/native-result`, using its trusted authentication. Compute SHA-256 over the exact uploaded UTF-8 bytes in a header, not over a JavaScript reserialization. Server bounds raw body, verifies hash, parses strict DTO, and validates scan/organization/active dispatch binding. Store exact hash for retry identity. Native retained report digest remains a separate canonical artifact hash.
7. Consumer transaction atomically records terminal receipt/hash, native disposition, final report, actual counters/holds and legacy status projection. Identical hash retries return the stored receipt without repeated billing/fan-out; a different hash for the same dispatch conflicts. Stale dispatch cannot complete a newer attempt. Existing cancellation or a superseding host fence cannot be overwritten; contradictory full result can be retained only as evidence with non-upgraded disposition. Transaction semantics, not event arrival, decide this.
8. After commit publish terminal UI/outbox notification derived from committed native disposition. No native generic scan_completed event before or after this transaction. Progress events are observation-only; stale cost/progress cannot overwrite terminal totals. Preserve native terminal receipt even if notification delivery fails.
9. Acknowledged outbox entries can be retired; unacknowledged entries remain retryable. Bound individual fetch timeout, total attempt/deadline, queue bytes and cancellation independently. Do not claim exactly-once transport; storage is idempotent.

Legacy row status can remain a compatibility projection initially: CompletedWorkflow/Retained -> complete; model BudgetLimit -> cost_exceeded; explicit cancellation -> cancelled; other partial/deadline/unknown/publication failure -> failed. The dedicated native disposition remains authoritative and UI must display Unknown/Partial distinctly, not generic failure or Clean. Native claims should initially remain in the typed report view; avoid feeding them to executable-finding/repair/escalation/eligibility automations. If listing them is required, introduce an explicit Unverified claim projection instead of manufacturing verificationSpec, researchEvidence, feature vectors or confidence.

## Accounting, policy and authentication

- Model currency Units is not USD. Managed billing requires frozen trusted rate provenance and explicit micro-USD units (ScanCurrency::Usd); convert integer charged values to USD once with exact scale and bounded checked arithmetic. Preserve held reservations as unresolved, not billed measured use and not zero. Include invoice/estimate authority in consumer receipt. Do not bill Unknown as a completed measurement.
- Use complete validated original account totals from ScanSnapshot/ScanOutcome, not displayed evidence prefixes, streamed event sums, number of findings, or guessed totalAttacks. HTTP requests count conservative admitted physical hops; expose that definition. Distinguish response charged bytes from unresolved reserved bytes.
- A real empty review qualifies by durable native root/review provenance and matching grant; it needs no fake legacy tool event or zero-cost report to evade the ghost guard. The typed route has its own validation, leaving the legacy guard unchanged.
- Scope hosts/path prefixes/denials/methods/headers, static origin auth, redirect policy, budgets and deadline must compile into the actual frozen HttpProfilePolicy/ScanProfile. Do not silently ignore worker knobs. Reject ambiguous zero rate/deadline and unsupported syntax before launch; do not guess legacy zero semantics. Default 5 rps/1800 s is explicit only when the selected managed policy declares those defaults.
- Legacy enforcement `requests_out_of_scope_blocked`, `peak_rps`, and combined target/local `rate_limited_count` are not all native measured counters. First typed envelope uses unavailable with a reason for unmeasured fields; UI must not render them as zero. Derive any supported statistic from validated full events with an exact definition. Do not add unrelated telemetry merely to populate the legacy required schema.
- New durable `target_auth_revision` is a host-managed opaque credential version, rotated atomically on credential changes, captured in dispatch/grant and HttpAuthDescriptor. No raw-secret hash or sink capability as revision. Encryption-key rewrap alone need not change semantic credential revision; ciphertext identity is not the authority contract. Retries preserve original version; changed credentials cannot be supplied under an unchanged version. Do not resume an old uncertain scan with new auth.
- Map bearer/header/cookie/basic to origin-bound StaticAuth only. Validate header/cookie syntax, duplicate/protected collisions, Basic encoding and all public-policy secret-reflection checks with existing zero-http rules. No browser login, OAuth target refresh, cookie jar/stateful auth, or cross-origin credential forwarding is introduced.
- Target credentials, model credentials, controller bearer and guest ingestion capability remain separate. Native guest does not need a final publisher capability. Progress can flow through controller stdout relay under a dedicated nonterminal native event type, with bounded framing and no raw model/target secret payload.

## Proposed ownership and files

Native runtime owner: zero-cloud-compat/src/managed.rs + tests, bounded writer helpers; minimal immutable managed binding in scan admission/provenance if necessary. Reuse frozen zero-store scan/account authority; no alternate budget system.
Native frontend owner: zero-cli/src/managed_scan.rs, strict private grant loader and args; protocol managed_scan.rs only after DTO agreement; local executable fixtures.
Cloud consumer owner: packages/cloud-contracts/src/native-scan.ts (+ shared type/export), orchestrator routes/native-scan.ts or a dedicated scans route branch, app authentication/body limit, storage interface/db transaction, schema/migration for terminal receipt and native disposition; dashboard native report/claim/status view.
Cloud worker owner: runners/args.ts/select.ts/scan-prep.ts/types.ts for explicit contract selection and grant; secret-crypto integration plus target auth revision propagation; run-storage/scan-body native file recovery branch; cloud-sink typed raw-byte endpoint; store/outbox persistence and retry. Both E2B and MSB use shared scan-body, so gate unsupported runner features explicitly.
Root integration owner: matched DTO golden files, lock/dependency changes if later needed, release manifest version checks and bounded local qualification. No release manifest/image/template deployment in this implementation slice without separate authorization and release proof.

## Required local tests before freeze

1. Rust -> real TypeScript strict schema golden envelope for completed empty review, Unverified claims, every partial reason, Unknown with model/HTTP holds, ReportTooLarge, Unavailable; no numeric invention or legacy schema coercion.
2. Actual local native executable/provider/target fixture through mocked sandbox files and worker controller parser to typed consumer transaction; no live target, E2B creation or paid provider.
3. File temp/rename failure preserves old artifact; wrong scan/dispatch/hash, oversized file, corrupt file + clean marker, duplicate/conflicting markers and stderr injection reject. Single terminal marker only after file commit.
4. Crash after native file, after outbox stage, after consumer commit before ACK; controller restart republishes identical bytes without any provider/target socket. Changed bytes conflict; cross-org/scan/dispatch, old dispatch and untrusted guest terminal authority reject.
5. Completion before/during/after cancel, stale progress after final, out-of-order cost events and duplicate final: no partial -> Clean regression, no repeated billing/claim fan-out, Unknown holds persist.
6. Original shared root/child/experiment budgets remain one account. Missing usage is unknown, repeated cumulative usage is not summed, units never become USD, zero-finding real review is accepted only through native provenance.
7. Credential rotation changes revision and fresh grant; cached retry needs no current secret. The host credential update path cannot retain an old revision when changing secret material; forged/reused dispatch credential bindings reject. Public native pins alone cannot detect a lying host that replaces secret bytes while preserving its asserted revision, so document this trusted-host boundary explicitly. Target bearer/cookie/basic canaries never appear in grant/report/log/event. Sink bearer never reaches target. Redirect origin boundary and decoded reflection redaction remain real local transport tests.
8. Legacy http_audit/parser/secure/report recovery/event tests unchanged; native branch cannot be accidentally selected by old environment variables or unrecognized version. UI labels claimed severity and Unverified correctly; unsupported metrics display unavailable.

## Remaining parity gaps (not closed by this adapter)

This enables only current snapshot-free scoped HTTP investigation and its joined actors/experiments. It does not implement repository acquisition, legacy broad tool inventory, browser/session-reset authentication, independent production vulnerability verification, repair/PR flows, complete enforcement metrics, durable arbitrary event replay, distributed global spending accounts, or autonomous production strategy activation. Real deployment/consumer authorization and image/template compatibility remain separate qualification gates.

## Native producer implementation boundary

`RunManagedScan` reuses the standalone controller and actual root actor. Store
schema17 is unchanged: an optional full managed grant is part of the original
hash-checked intent. Fresh admission compares the actual configured provider
pins, normalized HTTP policy, target and scan profile before effects. The
effective deadline is the earlier of the profile duration and absolute grant
expiry. Existing standalone intent identity is preserved.

CLI retries compare the captured grant before loading current credentials. An
expired but identical grant may inspect and republish settled state; it cannot
start work again. Active duplicates cannot publish a terminal. If retained work
is still marked Running after its process died, an exact managed invocation may
claim the existing exclusive engine lock and recover it to Unknown without
loading current credentials. A live owner keeps the lock and the retry fails
without cancelling it. Read-only inspection never performs this recovery. Controller,
target and provider credentials remain distinct; this producer performs no
cloud upload. Host revision values assert trusted host decisions; they are not
signatures and cannot detect a host lying about which secret a revision names.

The current terminal type contains the stable native scan record, statuses,
closure, original model and HTTP account totals, optional actual outcome,
original `native_publication`, managed `publication`, and explicit unavailable
enforcement metrics. Missing recovered outcomes stay absent. Failed full-report
reads preserve validated metadata and original publication separately, publish
Unavailable and return an error exit. Invalid grant or metadata evidence fails
closed without a file or marker. Only a committed terminal file permits the
`0SEC_NATIVE_RESULT` marker, whose hash covers its exact bytes and final newline.

The cloud controller must still authenticate its own captured dispatch/grant,
validate this versioned envelope and implement the durable outbox/terminal
transaction described above. Neither a valid JSON hash nor this experimental
producer establishes consumer integration, billing authority, release-image
selection, independently verified findings or general scanner parity.

## Consumer source checks before implementation

The current cloud source uses opaque organization IDs accepted by
`org-context.ts`, not exclusively UUIDs. Preserve their exact case and bytes.
A new result route needs an explicit controller/operator-only authentication
branch: the generic scans-route fallback currently requests read scope. Do not
add native terminal authority to the guest events/findings/artifacts capability.

The existing daily-budget trigger records known terminal cost and maps NULL
cost to zero; it does not reserve native in-flight allowances. Managed admission
therefore needs a durable original native allowance hold and headroom checks
that include those holds. Unknown outcomes or missing guest state retain this
capacity protection. Account telemetry and reserved allowance are distinct from
measured billed use. Accepted known cost must not be charged a second time by
a new route in addition to the existing terminal-cost trigger.

Current worker drain/requeue creates a fresh sandbox. The native branch must
not repeat an investigation with the same grant in an empty database: a local
command identity provides idempotence only within the original retained state.
Capture durable launch identity before dispatch and separate execution from
delivery retries. Recover the original database, retry staged bytes, or retain
Unknown/unavailable; do not replace uncertainty with another funded execution.

`target_secret_key_version` identifies encryption format, not credential
revision. Capture a revision changed by every credential-material update. The
existing sandbox file reader also needs a physical byte bound before it can
qualify native terminal recovery. These are implementation requirements, not
capabilities established by the producer tests.

Wire hashes have three distinct inputs: exact terminal file bytes including the
newline; retained report bytes in typed Rust serialization order; and normalized
Rust canonical Value JSON for grant/profile/account identity. JavaScript object
stringification is not an interchangeable canonicalizer (numeric-looking keys
and UTF-8 ordering differ). Qualify the consumer against Rust-produced fixtures
and preserve the raw nested report byte span when validating its artifact hash.
