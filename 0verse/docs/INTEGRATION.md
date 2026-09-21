# Integration — how 0verse, foxguard, and the managed platform fit together

> Status: 2026-08-20. Scope frozen under 0 ADR-066: 0verse is an
> evidence-producer/notary, not a generic dispatch engine. This document
> distinguishes implemented seams from live-proven and operational integration
> using the [canonical maturity vocabulary](../ARCHITECTURE.md#scope-decision-and-maturity-vocabulary).
>
> Current checkout correction: 0 now has an **opt-in local `analyze_binary`
> bridge**. The managed generic-dispatch lane remains separate and parked;
> the historical scope decision must not be read as absence of the local tool.

## The product line

```
  managed            MANAGED PLATFORM (private operations)
                     signed Hyper-V evidence import today · generic PoV seam planned ·
                     labeled dataset · trained triage · disclosure routing
          ▲
          │ signed evidence import: Hyper-V-specific today;
          │ provider-neutral import remains planned (dispatch is parked)
  0verse             Apache-2.0, public in 0sec-labs/0 · out-of-band binary RE + verifier/notary
                     ingest → decompile → lift → analyze → reason → dynamic → PoV → report
          │            │                                    │
          │            └── analyze: shell out to ──►  foxguard (OSS, Rust C SAST)
          │                                           over normalized Ghidra pseudo-C
          └── dynamic/PoV: OPEN oracles
              differential crash · canary-marker capability · public-advisory dedup
```

Three projects, three roles: **foxguard** = source/decompiled-C static analysis;
**0verse** = no-source binary RE + evidence production/notarization; **the
managed platform (proprietary)** = the closed platform. Today its wired 0verse
seam imports signed Hyper-V evidence; a provider-neutral PoV importer remains
planned and gated. foxguard is reused *inside* 0verse. The source-side engine's
oracle *concepts* are reimplemented in 0verse; its *learned/tuned/private-state*
versions stay the moat.

The generic managed binary job type and execution template remain **parked**
until the blind known-CVE stripped-ELF gate passes. The local harness tool below
is implemented; it is not registration, deployment, or qualification of that
managed lane.

## Local 0 harness integration

0verse lives under `0verse/` in this monorepo but is a separate Python 3.11+
package. Neither the 0 npm package nor its standalone installer installs it.
From `0verse/`, run `uv sync --frozen` for the core package; install the selected
backend separately (see [Ghidra setup](GHIDRA-SETUP.md)). Make `.venv/bin/0verse`
available on the launching process's `PATH`, for example by activating that
virtual environment before starting 0.

Set `ZERO_FEATURE_ZEROVERSE=1` when launching 0 and use an authorized local source
scope. The agent's `analyze_binary` tool accepts `binary_path`, `bug_class`,
`backend`, and `timeout_s`; the executor resolves the path within that scope and
requires a regular file. It runs one bounded `0verse scan ... --format ndjson`
with an eight-minute default and a thirty-minute maximum.

The child receives a sanitized environment, not the parent model credentials,
`GHIDRA_HOME`, or `ZEROVERSE_*` execution settings. The bridge does not pass
`--llm`, install engines, or enable target execution. A backend that depends on
those variables must be configured in its own launch environment; use the
standalone Python/CLI workflow for advanced execution and model configuration.
Do not interpret missing-backend output as a clean security result.

Sources: `packages/core/src/agent/features.ts`,
`packages/core/src/agent/tools.ts::analyzeBinary`,
`packages/core/src/agent/tools/0verse.ts`, and
`packages/core/src/agent/sanitized-env.ts` (paths relative to the monorepo root).

---

## foxguard — reused inside 0verse

**Key fact:** foxguard already parses **C** (`tree-sitter-c`; `src/rules/c_taint.rs`
has 4 taint classes — CWE-120 buffer overflow, CWE-134 format string, CWE-78 cmd
injection, CWE-89 SQLi). Its taint engine keys on **libc callee names**
(`read`/`recv`/`getenv`/`system`/`strcpy`/`sprintf`/`memcpy`…) — and those names
**survive decompilation** (Ghidra preserves imported symbols). That's exactly why
it's a fit for decompiled code.

**Integration path:** 0verse normalizes Ghidra pseudo-C (strip/rewrite
`undefined*` types, `CONCAT*`, cast noise), writes a `.c`, and shells out to
`foxguard scan --format sarif` (or the versioned `foxguard-adapter` JSON
protocol). Parse SARIF in Python. **No FFI, no Rust build coupling.**

**Dependency (optional, graceful-degrade):** foxguard is an *optional external
tool*. The pre-pass discovers it via `$ZEROVERSE_FOXGUARD` (absolute path or PATH
name; legacy `$FOXGUARD_BIN` still honored), then `foxguard` on `PATH` (the
canonical install — `cargo install` / symlink into `/usr/local/bin`), then
`/usr/local/bin/foxguard`, then the legacy bench build dir. If none resolves the
stage **skips honestly** (records "foxguard not found") and never crashes — every
candidate probe is wrapped so an unreadable path (e.g. CI without `/root` access)
can't raise.

**Caveats (be honest):**
- Ghidra noise (indirect calls `(*pcVar)()`, SSA-ish `uVar1`, gotos) reduces recall
  and adds some false positives. Normalization mitigates, doesn't eliminate.
- **No C++ grammar** in foxguard — C++-derived binaries parse poorly.
- foxguard's source/sink lists are tuned for clean libc names; extend them to
  cover what Ghidra actually emits (thunks, raw syscalls).

**Role in 0verse:** the fast static pre-pass at the **analyze** stage. It does not
replace the P-Code backward-slicer (foxguard's C taint is intraprocedural,
single-file, flow-insensitive) — it's a cheap first net whose hits feed the LLM
triage + dynamic confirmation like any other hypothesis.

---

## Source-side engine oracles — concepts reimplemented openly; learned versions stay the moat

The source-side engine is public in `0sec-labs/0`; the managed platform's
managed operations, trained models, and dataset stay private. 0verse reimplements
from **concepts only — never copy tuned prompt text or learned state.** The split
(from reading the source-side engine's `packages/core` triage/oracle code and the
`services/` gates):

### 0verse builds OPEN — this is the core value of a verify-before-report tool
- **Differential crash oracle / PoV verifier** — crash the target under a
  sanitizer (ASan/UBSan/MSan) and confirm clean behavior on a control; verdict
  driven by an *external deterministic check* (signal, sanitizer abort, marker),
  **never LLM self-grading**. (source-side engine analog: `cybergym-runner`, `verify-verdict.ts`.)
- **Canary-marker capability oracle** — mint a unique per-run token, compile it
  into the PoC, credit a capability only on the token-bound marker line, and close
  the five false-confirmation vectors: stale/replay, echoed-intent,
  capability-without-witness, sprayed-but-didn't-land, privilege-from-privilege.
  This is 0verse's headline open differentiator. (source-side engine analog: `exploit/oracle.ts`.)
- **Dedup** — stack-trace + content-token (Jaccard) + CWE-class, against **public**
  CVE/GHSA/OSV. (ClusterFuzz-style crash bucketing from Buttercup transfers verbatim.)
- **Exploitability heuristics** — deterministic regex reachability labels
  (`reachable-untrusted/api-misuse-only/theoretical/…`) + a SyzScope-style impact
  ceiling (`dos-only<info-leak<oob-write<uaf-control`). Public-paper-derived; rule-based.
- **Gate composition discipline** — cheap filter → expensive prover; explicit
  fail-OPEN for reachability vs fail-CLOSED for the last gate before "confirmed".
- **An open handcrafted feature vector** (VulnBERT-style *idea*) — but our own names,
  not the source-side engine's exact registry.

### Stays the managed platform's MOAT — 0verse must NOT replicate; cloud wraps it
- The **labeled dataset**: `(finding, attempted-PoC, ground-truth, feature-vector)`
  rows from paid scans at scale (the closed feedback loop). *0verse should emit its
  oracle verdicts in a clean capturable shape so the cloud can build a dataset — but
  ship no curated corpus.*
- The **trained triage classifier** (fused VulnBERT, ~92% recall / 1.2% FPR) that
  early-terminates boring scans.
- The **specific tuned LLM gate prompts** (the 5-check adversarial gate, the skeptic's
  burned-us checks) that encode hard-won real over-claim failures. 0verse ships
  *deterministic* equivalents + a generic "adversarially refute this" pass.
- **Own-sent dedup + disclosure routing** — depend on operator-private state.

**Net:** 0verse's open core is *deterministic, externally-checkable proof* — crash
it, mark it with a canary, confirm the marker, dedup against public advisories,
classify reach by rule. The supported cross-project shape is signed evidence
produced out of band and imported by the platform. Generic platform dispatch is
not implied by the local API, MCP server, cloud sink, or reference adapter.


## CI: the PoV-reproduction gate (#9)

The exported monorepo's current workflow is
[`../../.github/workflows/0verse.yml`](../../.github/workflows/0verse.yml).
It runs on relevant main pushes and same-repository pull requests, on a
self-hosted Linux x64 runner with Python 3.11 and `uv` 0.11.2. Fork checkouts
are not executed. It syncs `--frozen --extra dev`, runs Ruff, strict mypy and
pytest, then builds and smoke-installs the Python wheel. Heavy engines and
privileged Windows execution are not part of that workflow.

The older standalone-repository `ci.yml`, `benchmark-gate.yml`,
`windows-capability.yml`, and their retained Actions receipts describe historical
CI, not workflows shipped under `0verse/.github/` in this checkout.
The local `make benchmark` recipe still builds the engine image and invokes
`benchmarks/run.sh`; it is a separate toolchain-dependent check, not an
always-on monorepo gate.

**`benchmarks/run.sh` is the source of truth for the gate.** It compiles each
corpus program and asserts the pipeline confirms the expected `source:sink` with a
reproducing PoV. Run it in either environment:

```sh
make benchmark                       # build the image + run the corpus (portable)
bash benchmarks/run.sh               # native, when Ghidra is already on the host
```

LLM triage runs in deterministic **mock mode** for the gate (zero API spend, no
flakiness). CASR is optional — when `casr-gdb` is absent the oracle degrades
gracefully and the native-signal differential oracle still confirms the PoV.

The angr stage (#5) has its own proof harness, `benchmarks/angr_proof.py`
(`make proof-angr`): it compiles `benchmarks/guarded.c` and shows angr both
**concretizing a witness** (the magic-gated caller) and **pruning an UNSAT
hypothesis** (the contradiction-gated caller) on the same sink.


## M5 — backends & the embeddable integration surface (#27/#28/#29)

### Versioned execution adapters

Static format support and runtime support are separate capabilities. The
embeddable API accepts an explicit `ExecutionBackend` through `ScanOptions`; no
remote worker is inferred from environment variables. Every execution returns
the v1 contract shape from `zeroverse.execution`: exact target/input SHA-256,
backend and oracle identity, environment identity, normalized status, output,
and a signal or oracle signature for crashes. Transport errors cannot become
crash evidence, and evidence whose hashes do not match the request is discarded.
The v1.5 result records adapter `ERROR`/`TIMEOUT` as `infra-failed` and adapter
`UNSUPPORTED` as `unsupported`; failed execution, PoV, and report stages are never
labelled completed.

When the caller supplies both a real LLM and a compatible explicit adapter, the
memory-safety lane now asks the existing structure-aware synthesizer for up to six
parser-valid candidates per hypothesis before trying the deterministic boundary
family. This is bounded to the eight highest-ranked compatible findings and a
1 MiB pipeline synthesis policy per candidate. Empty output and backend failure
are recorded separately; neither
disables the generic fallback. Candidate provenance is retained in the PoV, but
only the adapter's clean-control/crashing-candidate differential can confirm it.
The default `llm=None`/mock path performs no synthesis call.

The default static call is unchanged. Native dynamic confirmation is now
fail-closed until the operator explicitly selects its trust boundary:

- `ZEROVERSE_EXECUTOR=local` authorizes the historical local subprocess oracle for
  trusted fixtures only;
- `ZEROVERSE_EXECUTOR=msb` selects the remote microsandbox oracle. Each verdict uses
  a fresh microVM, digest-pinned Ubuntu image and `msb` binary, root-owned staged
  artifacts, an unprivileged target process, and target/input/tool/sandbox
  provenance. The microVM is removed after the verdict.

This environment-selected seam is the legacy in-process oracle boundary; it does
not replace or implicitly configure the explicit `ExecutionBackend` contract
above. With neither selection, dynamic execution returns an infrastructure error
instead of running an untrusted binary on the analysis host.

```python
import os

from zeroverse import api

os.environ["ZEROVERSE_EXECUTOR"] = "local"  # trusted fixture only
result = api.scan("/path/binary", api.ScanOptions(backend="rizin"))
```

An owned Windows file-parser lab can be injected deliberately:

```python
from zeroverse import api
from zeroverse.execution.windows import WindowsExecutionBackend
from zeroverse.windows_oracle import WindowsWorker

executor = WindowsExecutionBackend(
    WindowsWorker("owned-windows-lab"),
    scope_mode="LAB_ONLY",
    authorization="operator-owned disposable research VM",
    oracle="auto",
)
result = api.scan(
    "/path/target.exe",
    api.ScanOptions(execution_backend=executor),
)
```

The Windows snippet documents a low-level execution seam, not a bounty-scope
bypass or an operational worker. Windows execution expansion is **parked**; its
adapter, tests, and fixture evidence remain in-tree without a live-proven claim.
The separate setup/trigger authorization manifests remain mandatory for any
future stateful Hyper-V experiment. Chromium/Firefox component-harness adapters
likewise remain implemented research seams only. Browser execution expansion is
**parked**, undispatched, and not live-proven or operational.

These are implemented low-level research seams, not an operational lane driven by
a scan platform or external agents.

### Decompiler backends (#27) — Ghidra is replaceable

`backends/contract.py` defines the explicit `DecompilerBackend` Protocol
(`ingest → ProgramMeta + per-function IL` the slicer consumes) and `ProgramAdapter`
(an `ILAdapter` carrying `ProgramMeta`). Three backends register:

| backend | toolchain | fidelity |
|---------|-----------|----------|
| `ghidra` | PyGhidra + Java (`GHIDRA_HOME`) | High P-Code SSA — highest |
| `rizin`  | `r2` + `r2pipe` + r2ghidra `pdg` (no Java) | pseudo-C IL — lower |
| `angr`   | `angr` (pip, pure-Python) | pseudo-C IL — lower, partial coverage |

Select with `ZEROVERSE_BACKEND=auto|ghidra|rizin|angr`. **auto** prefers Ghidra and
falls back to rizin then angr. The non-Ghidra backends mine the IL from pseudo-C
(`backends/cdecomp.py`): they recover call sites + argument variable names (the
memory-flow basis) and return-value def-use, but **not** SSA-grade def-use and
**no per-instruction addresses** — so the angr reachability stage (#5) is skipped
for them; the slice + differential oracle still confirm. Honest, and flagged in
`note`. Proof: `benchmarks/m5_backend_proof.py` slices+confirms `read→strcpy` with
Ghidra disabled.

### Embeddable API + machine contract (#28)

```python
from zeroverse import api
result = api.scan("/path/binary", api.ScanOptions(backend="rizin"))
print(api.format_result(result, "ndjson"))
```

CLI equivalent: `0verse scan <binary> --format ndjson|sarif|json [--backend ...]`.
The **versioned** result contract (`api.CONTRACT_VERSION`, currently 1.5) is
documented in [`RESULT-CONTRACT.md`](RESULT-CONTRACT.md): a flat, stable
`{id, class, severity, file/func/offset, confirmed, pov_path, repro_cmd, …}` finding
shape plus one top-level terminal state, reason, and structured per-stage outcomes.
PoV-is-truth is in the contract — `confirmed=true` and terminal state `confirmed`
only with a reproducing PoV. Empty findings are successful only when the terminal
state is `no-findings`; infrastructure, unsupported, skipped, and cancelled scans
remain failures. The current cloud endpoint has no non-completing report envelope:
`final: true` immediately marks the scan complete, while `final: false` reports are
rejected. The reference sink therefore uploads no report for a failed terminal
state, logs the terminal reason, and exits non-zero so worker failure handling owns
the transition. When live finding events are enabled, only per-finding events sent
before that failure may remain in the cloud. Only `confirmed` and `no-findings` emit
the cloud completion marker.

### Machine contract and reference cloud adapter (#28)

The versioned NDJSON contract can be consumed by a managed scan platform, and a
reference managed-lane example demonstrates parsing and promotion rules. This is
**implemented contract scaffolding**, not a registered binary job type or an
operational platform lane.

Under ADR-066, the only wired 0verse-to-platform seam today is the specific
signed Hyper-V evidence importer. A provider-neutral PoV importer remains planned.
A platform-dispatched 0verse container, generic binary job type, and E2B template
are **parked** until the blind known-CVE stripped-ELF gate passes. Until then,
generic managed dispatch is operationally **unsupported**. This does not remove
the opt-in local `analyze_binary` tool described above, and `confirmed=true` in
local output does not by itself make a platform finding.

The reference adapter is dependency-free (`scan_lane()` + `parse_ndjson()`) and
remains useful for contract tests. Nothing in this repository registers,
deploys, or authorizes a production scan lane.

### MCP bridge (#29) — external agents drive the engine

From `0verse/`, `uv run --frozen --extra mcp python -m zeroverse.mcp` runs a stdio
MCP server exposing `scan_binary`, `list_findings`, `get_pov(finding_id)`, and
`get_report(format)`. These are wrappers over the local API, not the 0 CLI's
own MCP server or a hosted binary-analysis service. The optional `mcp` extra
installs the official SDK; without it the module uses a minimal
JSON-RPC-2.0-over-stdio loop (`initialize`/`tools/list`/`tools/call`).

An MCP client must launch the correct environment rather than an arbitrary
system Python. For example, replace the absolute checkout path below:

```json
{
  "mcpServers": {
    "0verse": {
      "command": "uv",
      "args": ["run", "--directory", "/absolute/path/to/0/0verse", "--frozen", "--extra", "mcp", "python", "-m", "zeroverse.mcp"]
    }
  }
}
```

The server sees files and credentials available to that process. Choose its
working environment and execution policy deliberately; MCP is not a sandbox
or a substitute for authorization.
