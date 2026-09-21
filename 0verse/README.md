<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/0verse-mark-white.png">
    <img src="assets/0verse-mark-ink.png" alt="0verse" width="88">
  </picture>
</p>

<h1 align="center">0verse</h1>

<p align="center">
  <strong>Evidence-first binary analysis. It produces proof-of-vulnerability artifacts from compiled programs, and confirms a finding only when a reproducing oracle agrees.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-evidence%20producer%20·%20scope%20frozen-d97706" alt="status" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3fb950" alt="license" />
  <img src="https://img.shields.io/badge/core-Python-3572A5" alt="python" />
  <img src="https://img.shields.io/badge/PoV-is--truth-d97706" alt="pov-is-truth" />
</p>

---

> **Research-stage.** 0verse proves bugs in binaries — it is built to *produce
> evidence* (a reproducing crash), not to run autonomously at fleet scale yet.
> Read the capabilities below as research maturity unless stated otherwise, and
> the honest misses in [Honest limitations](#honest-limitations). Apache-2.0,
> shipped in this repo under `0verse/`.

## What it is

`0verse` is a **binary-native Cyber Reasoning System** for compiled programs with
no source. Its research pipeline supports a **find → prove → patch → verify** loop;
the patch lane is separately opt-in and confirmation requires a working executor:

- **finds** memory-safety and logic bug *hypotheses* via static slicing, bug-class
  lenses, and a mined seed registry;
- **attempts to prove** hypotheses with a reproducing **proof-of-vulnerability
  (PoV)**;
- **proposes patches** when `ZEROVERSE_PATCH=1`; and
- **verifies** a patch only against the reproduced PoV and available regression
  checks. This is not a guarantee that a binary is secure or a fix is complete.

It's the binary counterpart to a source scanner: when you have source, use SAST
([foxguard](https://github.com/0sec-labs)); when all you have is a compiled
artifact, use `0verse`. DARPA AIxCC scored on **source-available** programs;
0verse targets the harder **binary-only** setting — no sanitizers, no
ground-truth types, no symbols.

**The one rule — PoV-is-truth.** A finding without a reproducing input + crash
trace is a *hypothesis*, not a finding. `confirmed` is true **only** when a
deterministic oracle reproduces a PoV. An LLM verdict alone cannot set
confirmation. Review the oracle, target identity, control, and replay evidence;
this gate is not a universal zero-false-positive guarantee.

## Quickstart

Use **Python 3.11+** and `uv` from the **`0verse/` directory** of this repository.
This is a separate Python package: installing the 0 CLI with npm or the binary
installer does not install 0verse, Ghidra, or a dynamic executor.
The core install has no runtime dependencies and supports format triage.
Full analysis needs a decompiler; confirmation needs a compatible execution
environment. No PyPI or public image channel is assumed here — use the locked
checkout or build the image locally.

```bash
cd 0verse
# Day-one triage from a locked checkout — format / arch / mitigations, no deps.
uv sync --frozen
uv run --frozen 0verse triage ./target

# Request the pipeline with a mock LLM; missing engines/execution are not a clean bill.
uv run --frozen 0verse run ./target --bug-class memory-safety

# Real-provider lanes need their optional SDKs and your own credentials.
uv sync --frozen --extra llm
uv run --frozen --extra llm 0verse run ./target --llm codex     # ~/.codex/auth.json
uv run --frozen --extra llm 0verse run ./target --llm claude    # ANTHROPIC_API_KEY
uv run --frozen --extra llm 0verse run ./target --model glm-4.6 # Z_AI_API_KEY

# Emit the versioned machine contract for a platform/agent to ingest.
uv run --frozen 0verse scan ./target --format ndjson --backend auto

# Sweep a fleet from one known seed; confirmations still require a PoV per target.
uv run --frozen 0verse fleet --seed-archetype cmdi --fleet ./vendor-bins
```

Install and select a backend using [Ghidra setup](docs/GHIDRA-SETUP.md) or the
fallback requirements in [Integration](docs/INTEGRATION.md#decompiler-backends-27--ghidra-is-replaceable).
For the Ghidra/angr/AFL++ toolchain, build the Linux x86-64 image locally:

```bash
docker build --platform linux/amd64 -t 0verse:local .
docker run --rm --platform linux/amd64 -v "$PWD:/work:ro" \
  0verse:local scan /work/target --format json
```

The image includes JDK 21, Ghidra 12.1.2, angr, AFL++, and x86-64 QEMU-mode
support. It does **not** install every optional extra: Qiling, binwalk, the
radare2/r2ghidra fallback, and firmware cross-toolchains need separate setup.
ARM hosts need amd64 container emulation. Container execution alone does not
select an oracle or turn the image into a managed analysis service.

Dynamic execution of a target is **opt-in and fail-closed** — never a silent host
subprocess. It's disabled unless you choose an executor:

```bash
ZEROVERSE_EXECUTOR=local uv run --frozen 0verse run ./target # trusted fixtures only
ZEROVERSE_EXECUTOR=msb uv run --frozen 0verse run ./target   # separately provisioned remote microVM
```

`msb` needs an operator-provisioned SSH/KVM host and the pinned microsandbox
toolchain; setting the variable does not provision them. Never enable `local`
for an untrusted binary on a workstation. Generated PoV scripts are executable
artifacts too; replay them only inside the authorized execution boundary.

For `scan`, inspect `terminal_state`, `status_reason`, and `stage_outcomes` in
the emitted contract. A local command can print an `infra-failed` result and exit
zero; an empty finding list is not proof that analysis completed.
See [Result contract](docs/RESULT-CONTRACT.md).

Embed it, or expose it to an agent over MCP:

```python
from zeroverse import api
result = api.scan("/path/to/binary")            # -> versioned ScanResult (PoV-is-truth)
print(api.format_result(result, "ndjson"))
```

```bash
uv run --frozen --extra mcp python -m zeroverse.mcp
```

### Calling 0verse from the 0 harness

The local agent tool `analyze_binary` is **off by default**. Put the installed
`0verse` executable on the launching process's `PATH` (for example, activate
`0verse/.venv`), then launch 0 with `ZERO_FEATURE_ZEROVERSE=1` and an authorized
local source scope. The tool accepts only a regular file confined to that scope;
its arguments are `binary_path`, `bug_class`, `backend`, and `timeout_s`.

This bridge launches `0verse scan --format ndjson`, not a remote worker. It does
not install engines, forward provider credentials or `ZEROVERSE_*` settings, or
enable dynamic execution. Configure and run advanced 0verse workflows separately.
Its default timeout is eight minutes, with a thirty-minute ceiling. Confirmed
results and unconfirmed hypotheses remain separate. A local bridge is not the
managed platform's generic binary-dispatch lane.

### Offline firmware evidence

Firmware Scout has a hardware-free CLI. From this directory:

```bash
uv run --frozen 0verse scout capture --fixture standard --output ./scout-example
uv run --frozen 0verse scout inspect ./scout-example
uv run --frozen 0verse scout report ./scout-example --format md
```

The output directory must be new. This captures a deterministic virtual trace,
not a physical ECU. Inspection/reports validate sealed Scout evidence and
separate observations, inferences, and unknowns. They do not open a live
interface, transmit frames, dump firmware, or confirm vulnerabilities.
See [Firmware Scout safety](docs/FIRMWARE-SCOUT-SAFETY.md).

## Capability matrix

Read a row as **implemented / fixture-proven** unless a higher maturity is
stated; parked and unsupported boundaries are called out under *Honest
limitations*. Numbers are historical and condition-specific, not operational
claims.

| Axis | Coverage |
|---|---|
| **Container formats** | ELF · Mach-O (thin + FAT, exec/dylib/kext) · PE / PE32+ · Linux `.ko` · MIPS/ARM firmware (binwalk carve) |
| **Architectures** | x86-64 · arm64 · arm · mips o32 — ABI-aware slicing + cross-arch QEMU-mode fuzzing |
| **Confirmable bug classes** | buffer-overflow (stack/heap) · integer-overflow · format-string · use-after-free / double-free · command-injection — **all PoV-confirmable** |
| **Hypothesis-only classes** | auth-bypass / logic · kernel `.ko` LPE families · IOKit/XNU `externalMethod` dispatch — ranked **leads**, never auto-confirmed |
| **Discovery** | source→sink **slice** → foxguard static pre-pass → cheap→expensive **LLM triage funnel** → **angr** concolic prune → **AFL++** harness-synth fuzz (QEMU-mode, CMPLOG, directed) → **crash oracle** → **PoV** → **patch + verify** |
| **Seed registry** | 90 mined bug archetypes (kernel/userland/firmware, 2023–2025 CVE-grounded) — generalized patterns, no exploit code |
| **Decompiler backends** | **Ghidra** (default, free) · **rizin** (no-JVM fallback) · **angr** (pure-Python) — `ZEROVERSE_BACKEND=auto\|ghidra\|rizin\|angr` |
| **Isolated execution** | microsandbox (libkrun/KVM microVM) over ssh, opt-in & fail-closed: `ZEROVERSE_EXECUTOR=local\|msb` (unset = disabled) · `ZEROVERSE_MSB_HOST` (default `fuzzer`) · `ZEROVERSE_MSB_IMAGE` (digest-pinned Ubuntu 24.04) · `ZEROVERSE_MSB_SANDBOX` (per-lane names) |
| **LLM providers** | Anthropic Claude · ChatGPT-OAuth **Codex** (no API key) · GLM (z-ai) · any OpenAI-compatible gateway · deterministic **MockLLM** (the CI regression floor, never a capability lane) |
| **Integration** | embeddable `zeroverse.api.scan()` · `0verse` CLI · **MCP** stdio bridge · **versioned machine contract** (JSON/NDJSON/SARIF) · CRS-API / SARIF adapter |

Opt-in lanes stay flag-gated even though they're merged and tested:
`ZEROVERSE_DIRECTED=1` (sink-scored fuzzing), `ZEROVERSE_PATCH=1` (patch + verify),
`ZEROVERSE_SCHEDULER=1` (epoch scheduler + budget), `ZEROVERSE_FLYWHEEL=1`
(preseeded memory priming). None can create a confirmation — only the oracle can.

## Measured results

> **Historical, condition-specific measurements** from the 2026-06-28 campaigns.
> Not a current operational-capability claim; do not generalize beyond the stated
> target, host, model, budget, and trial count.

The instrument is a ground-truth evaluation on
[Magma](https://github.com/HexHive/magma) — real upstream libraries (libpng,
libxml2, libtiff, lua, libsndfile …) carrying catalogued CVE-class bugs guarded
by fatal canaries.

**Speed vs. baseline AFL++ (real Magma, same canaries, 300 s/lane, 1 trial).**
0verse-CMPLOG wins **3 of 4** targets and loses the ungated control honestly:

| Target | 0verse | baseline AFL++ | |
|---|---|---|---|
| `libxml2` | **17 s** | 191 s | ~11× |
| `libsndfile` | **14 s** | never (>300 s) | — |
| `libtiff` | **28 s** | 38 s | win |
| `libpng` (ungated control) | 28 s | **9 s** | honest loss — CMPLOG is overhead with no gate to crack |

**Binary-native pipeline (real `gpt-5.5`, `-O0` fatal-canary builds, 5 C targets,
53 catalogued bug-sites, median of 3 runs on `c38878d`):** reaches a **median
8/53 sites (15%)** and confirms a **median 4/53 through the fuzz drivers (range
3–4)**, with **zero false positives in every run** — no confirmed PoV on a non-bug
site or a fixed build.

**Regression floor (not a capability number).** A 14-item held-out corpus of
real-CVE reproducer pairs (built vulnerable *and* fixed) runs under the
deterministic **MockLLM** as the CI floor (`capability_measure: false`): located
9/9, confirmed 6/9, **0 false positives on the 5 clean/fixed controls**. The
report stamps a floor banner so it can't be misread as performance.

**Honest caveats — read before citing.** Bounded budget, single model
(`gpt-5.5`), single backend (Ghidra), x86-64 ELF, 1 trial. Binary-native Magma
confirmation is bottlenecked by Ghidra cost on multi-MB drivers, the
intraprocedural slice, and libFuzzer-driver input synthesis — all surfaced, not
hidden. The fuzzing campaign is a 300 s/lane snapshot, not the multi-day paper
methodology. Full method and misses:
[docs/EVAL-GROUNDTRUTH.md](docs/EVAL-GROUNDTRUTH.md) ·
[docs/BENCHMARKS.md](docs/BENCHMARKS.md) · negative results in
[NEGATIVE-RESULTS.md](NEGATIVE-RESULTS.md).

## Architecture (in words)

A deterministic scheduler runs a bounded stage spine. Optional engines may
degrade with recorded outcomes; a missing required backend or execution
capability can fail the requested profile. Read the terminal state, not just
the number of findings:

```
ingest → decompile → lift → slice → foxguard pre-pass → seed-prime → bug-class lenses
       → LLM triage funnel → angr concolic prune → crash oracle → PoV → patch + verify → report
                                         ↘ fuzz complement (when the slice confirmed nothing):
                          harness-synth → AFL++ (QEMU/CMPLOG, directed) → oracle → PoV
```

- **ingest** routes ELF / Mach-O / PE / `.ko` / firmware and resolves arch/ABI
  (pure-Python, no deps).
- **decompile/lift** recover functions, pseudo-C, and an IL via the selected
  backend (Ghidra, else rizin/angr at lower fidelity).
- **slice + lenses + seeds** union many hypotheses (high recall by design);
  **angr** prunes the ones it proves unreachable.
- the **crash oracle** attempts to confirm candidates with a reproducing PoV; **patch + verify**
  (opt-in) marks a fix `verified` only when the PoV stops reproducing with no
  regression — the deterministic, LLM-free adjudicator.
- the **fuzz complement** catches bugs the slice structurally misses: the LLM
  synthesizes a harness, a compile→repair loop hardens it, and AFL++ fuzzes —
  optionally steered toward the suspected sinks.

Each stage is a module behind a typed interface, so backends swap cleanly and
stages run standalone (`0verse triage` is just stage 1). Full design:
[ARCHITECTURE.md](ARCHITECTURE.md) · [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md).

## Honest limitations

Binary-only analysis is much harder than the source-available setting, and
several lanes are honest degrades. We publish the misses in
[NEGATIVE-RESULTS.md](NEGATIVE-RESULTS.md), not hidden.

- **Kernel `.ko` / IOKit findings are hypotheses.** A bare `.ko` has no dynamic
  oracle on a userland host, so kernel seed findings stay `confirmed = false` and
  are never upgraded without a PoV — route the lead to a kernelCTF/KASAN harness.
- **Mach-O dynamic confirmation is unsupported; expansion is parked.** Static
  ingest and fixtures remain; no Mac/XNU live-proof is claimed.
- **PE execution expansion is parked** (adapter + fixtures in-tree, WinAFL not
  wired); **MIPS/ARM firmware** uses Qiling emulation, not native execution.
- **rizin/angr fallbacks are lower-fidelity** (no SSA def-use, no per-sink
  addresses → the angr reachability prune is skipped).
- **logic / auth-bypass is hypothesis-only** — no generic binary oracle.
- **foxguard is optional; analysis still needs a decompiler.** Missing Ghidra can
  fall back to rizin/angr, but no usable backend is an infrastructure failure,
  not a successful empty scan.
- The headline runs on real Magma libraries but under **bounded budget / single
  model / single trial**; the held-out set is a sanity/regression check, not the
  capability claim.

Per-issue status: [ROADMAP.md](ROADMAP.md). Reproducible baseline:
[docs/BASELINE.md](docs/BASELINE.md).

## License

Apache-2.0. Built on Apache/BSD-licensed engines (Ghidra, angr, capa, LIEF,
AFL++, Driller). Copyleft tools (Unicorn, Qiling, SymCC, rizin) are invoked as
subprocesses, never linked; Binary Ninja is an optional adapter, never bundled.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Rule #1:
**PoV-is-truth** — no reproducing crash, no finding.
