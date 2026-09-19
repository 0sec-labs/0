# Runtime Verifier Stage

## Status

`HuntScanOptions.runtimeVerify` is a shipped **injectable terminal gate**, not a
working E2B provisioner. `runHuntScan` composes it after `verify` and optional
`exploitability`. With no prior `verify` gate, it records a warning and skips
runtime verification.

`packages/core/src/stages/runtime-verify.ts` exports `makeRuntimeVerifier`, a
skeleton adapter. Setting `E2B_API_KEY` does not make it provision or boot a
target. Its default verifier returns `error` with reason `E2B driver not yet
implemented`. Do not use this factory's pass-through `confirmed: true` as proof
that a runtime exploit succeeded.

## Motivation

The cloudflare-os campaign (2026-08-05) demonstrated a sharp quality jump when
findings were PoC'd against a live target instead of only being source-reviewed.
That historical motivation remains distinct from the implementation status.
The intended pipeline was:

```
target → threat-model planner → per-lane finders → adversarial refuter
       → deployment-context filter → RUNTIME VERIFIER → report assembler
```

A source-backed candidate still needs a real executor, a target setup contract,
and exploit-specific observations before it can become runtime evidence.

## When it runs

- An SDK caller explicitly supplies `runtimeVerify`; it is not an automatic
  stage of every hunt or scan.
- The composed gate only receives findings that survived earlier gates.
- The **factory** checks `E2B_API_KEY` and passes through without calling its
  injected verifier when the key is absent. A separately injected `HuntVerifier`
  is not required to use this factory or E2B.
- `selfHostable` eligibility is a **caller responsibility/design requirement**,
  not an enforced target-descriptor field in this factory.

## What it does

Today's factory passes the finding, `finding.evidence.analysis` as `pocPlan`,
and an **empty string** as `endpoint` to `opts.verify`. It does not provision a
sandbox, launch a service, discover a port, enforce a verifier deadline, persist
transcripts, or tear down infrastructure.

A real integration must supply those behaviors and enforce authorization and
isolation itself. In particular, a temporary directory, an E2B credential and a
model's `pass` verdict are not evidence of a sandbox boundary.

### Verifier input/output contract

```typescript
interface RuntimeVerifierInput {
  finding: Finding;
  pocPlan: string;
  endpoint: string;
}

interface RuntimeVerdict {
  outcome: "pass" | "fail" | "error";
  confidence: number;
  transcript: string;
  reason: string;
}
```

These are the callback types, not the deterministic `VerificationResult`
schema. The factory converts the callback result to `{ confirmed, reason }`;
it does not attach `transcript` or mutate `finding.confidence`.

## Failure posture

| Condition in `makeRuntimeVerifier` | Current result |
| --- | --- |
| `E2B_API_KEY` unset | `confirmed: true`, explicit no-op reason; callback not invoked |
| Budget initialized at zero or below | `confirmed: true`, cost-cap skip reason |
| Default callback | `confirmed: true`, `ERROR` reason naming the absent E2B driver |
| Callback returns `pass` | `confirmed: true`, `PASS` reason with callback confidence |
| Callback returns `fail` or `error` | `confirmed: true`, `FAIL`/`ERROR` reason; no numeric downgrade |
| Callback throws | `confirmed: true`, exception text in reason |
| Callback hangs | No implemented timeout in this factory |

The skeleton never rejects a finding. This does **not** constrain an arbitrary
`runtimeVerify: HuntVerifier` supplied by a caller: that gate can return
`confirmed: false` and reject through normal `composeGate` semantics.

## Cost guardrails

`RUNTIME_VERIFY_COST_CAP` parses a positive dollar amount (default `$5`). The
factory initializes its closure budget to `opts.budgetCents` when supplied,
otherwise `max(50, floor(capInCents / 10))`. **No cost is deducted** in the
skeleton, so this is not an enforced per-scan spend limit.

The proposed `RUNTIME_VERIFY_SANDBOX_TIMEOUT` (120 seconds) and
`RUNTIME_VERIFY_AGENT_TIMEOUT` (60 seconds) are not read by this implementation.
They are design proposals, not working configuration knobs.

## Safety

A future or caller-supplied provisioner must establish self-hostability,
authorized target egress, credential isolation, resource limits, cancellation,
and teardown before executing a PoC. There is no shipped E2B image/network
isolation guarantee in this stage. Transcripts must be treated as untrusted
evidence, never as commands for the controller.

## Wiring

<span id="seam-a-composegate-recommended-for-mvp"></span>
### Seam A: composeGate

The implemented integration in `packages/core/src/stages/hunt-scan.ts` is:

```typescript
let verify = opts.verify;
if (opts.exploitability && verify) verify = composeGate(verify, opts.exploitability);
if (opts.runtimeVerify && verify) verify = composeGate(verify, opts.runtimeVerify);
```

The actual implementation also records a warning when runtime verification was
requested without `verify`. Earlier rejection short-circuits later gates.

### Seam B: VerifyLens (for multi-lens quorum)

A runtime lens participating in a multi-lens quorum remains a design option,
not the implemented runtime integration. It would require an executor and
target descriptor at lens construction and explicit rules for infrastructure
failure versus a negative reproduction.

### Chosen seam

`runHuntScan` implements Seam A. Integrators can supply a real verifier without
claiming that the built-in skeleton has acquired a working E2B driver.

## Dependencies

A working E2B provisioner, target startup descriptor and evidence persistence
are still required for the proposed managed-sandbox workflow. The skeleton
imports no E2B client.

## Future work

The original design still calls for an E2B driver, verifier handoff protocol,
self-hostable target descriptors, a structured PoC plan, target startup scripts,
measured cost accounting, hard timeouts, transcript retention and a real sandbox
integration exercise. These are not claims of shipped behavior or new runs.
