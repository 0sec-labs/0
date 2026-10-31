---
title: Code and binary analysis
description: Implemented source-review and reverse-engineering capabilities, their dependencies, and what each kind of evidence establishes.
---

This inventory describes the implemented paths reviewed on **October 28, 2026**.
An implemented analyzer, an installed dependency and a reproduced finding are
three separate things. Check the selected runtime and the individual result.

## Which part does what?

| Component | Role |
| --- | --- |
| **0** | Source/package review, agent investigation, tool execution, findings, verification and fixes |
| **0verse** | Separate Python engine for reverse engineering and evidence from compiled programs |
| **Ghidra** | Preferred 0verse decompiler/lifter; produces decompiled code and High P-Code SSA |
| **Foxguard** | External static-analysis pass; source findings can also supplement decompiled-code analysis |
| **0cloud** | Separate private runner and agent-core; public-engine capabilities are not automatically deployed cloud capabilities |

For a source repository, start with source review. For an executable or library
without source, use 0verse. When both are available, correlate their evidence
using the exact artifact, build and source revision.

## Finding vulnerabilities in source

| Capability | Implemented path | What the result establishes |
| --- | --- | --- |
| Repository review | `0 review`; unified source pipeline | Static and agent-investigated findings with supporting source locations |
| Static scanning | Foxguard by default; Semgrep selectable with `ZERO_STATIC=semgrep` | Candidate patterns/data-flow evidence; not proof that an exploit ran. Diff-scoped review skips the whole-tree Foxguard prepass. |
| Package analysis | `0 audit`; npm, PyPI, Cargo and OCI preparation paths | Analysis of available package content and relevant dependency/advisory evidence; ecosystem setup varies |
| Focused research | `deep-review`, variant `hunt`, assumption and specialized source profiles | Leads or hypotheses for follow-up; profiles guide investigation rather than independently proving a bug |
| Independent verification | Blind source verifier and evidence-kind classification | Independent source assessment, or reproduced evidence when a supported replay actually ran |
| Reproduction | `verify_finding` and deterministic replay runners | `reproduced`, `not_reproduced`, `skipped` or `error`, with the applicable evidence |
| Source fixes | Source-fix workflow and `generate_fix` | Candidate patches checked against required reproduction/verification specifications and regression commands; application is a separate action |
| HTTP protocol checks | `protocol_conformance` and HTTP oracle | Concrete request/response differences against a modeled expectation; divergence alone does not establish exploit impact |

Agent investigation can read files, follow source relationships, run available
tools and delegate work. Results depend on source visibility, model/runtime
configuration, budgets and the actual tools that ran. Source review does not
require Ghidra or Binary Ninja.

See [scan workflows](/scan-workflows/), [white-box analysis](/white-box-mode/),
[research workflows](/research-workflows/) and [verification results](/verification-result/).

### Starting a structured review from chat

The browser can start a structured source assessment; the CLI is not required.
Ask the chat to run the built-in **Whitebox pentest** workflow for the authorized
repository. Its template ID is `repository-review`, with dependency exposure,
trust-boundary and configuration/secrets phases.

The agent can inspect `list_templates` / `get_template` and request `start_run`.
The request stays queued until the chat turn finishes and the operator approves
the launch and target. A queued request is not yet a running review. The workflow
then calls the same `runUnified` assessment runner used by `0 review`; the built-in
template supplies its own multi-phase plan rather than necessarily reproducing
the CLI's default options. `get_run` and `get_run_results` expose status/results.

An ordinary conversational code inspection can also use file tools and agents
directly. Asking a question about code does not automatically start the structured
assessment workflow or all its phases. Inspect the recorded workflow run and
evidence to tell which path actually ran.

## Reverse engineering with 0verse

0verse does **not require Binary Ninja**. Its current backend registry contains:

| Backend | Status and role | Dependencies and limits |
| --- | --- | --- |
| `ghidra` | Implemented; preferred by `auto` | Ghidra installation, matching PyGhidra/JPype bridge and compatible JDK; recovers High P-Code SSA |
| `rizin` | Implemented fallback under this backend name | Currently drives `r2`/radare2 and `r2pipe`, preferring r2ghidra `pdg`; pseudo-C-derived IL has lower fidelity |
| `angr` | Implemented fallback | angr/CLE and decompiler support; its pseudo-C analysis adapter has lower fidelity than the Ghidra SSA path |
| Binary Ninja | Deferred; not registered or implemented | An external Mole worker would separately require an appropriate Binary Ninja license |

`auto` tries Ghidra, then the `rizin` backend, then angr. Explicitly requesting
an unavailable backend is an error; it must not silently become a successful
empty analysis. Installing the JavaScript CLI does not install these engines.

Ghidra recovers program structure. 0verse then normalizes it into its analysis
representation, follows bounded source-to-sink backward slices, applies bug-class
lenses, and produces candidates. Depending on configuration, later stages add
LLM triage, angr reachability checks, harness synthesis, fuzzing and replay/oracle
confirmation. These stages have separate dependencies and execution requirements.
Pointer recovery, indirect calls and backend fidelity limit completeness.

Mole's source/sink schema and slicing approach are already acknowledged prior
art in 0verse's design notes. An external Mole artifact importer would be an
additional comparison/evidence source, not a prerequisite for this pipeline.

### Binary capability boundaries

| Capability | Implemented boundary |
| --- | --- |
| Format and architecture triage | ELF, PE/PE32+, thin/FAT Mach-O, mitigation metadata and kernel-module recognition |
| Decompilation and static candidates | Available backend → normalized IL → bounded slicing and bug-class lenses |
| Bug-class lenses | Memory safety, integer overflow, format strings, use-after-free, command injection and logic-oriented hypotheses; oracle availability varies by class |
| Dynamic confirmation | Requires a compatible target, explicitly enabled execution route and actual replay evidence |
| Fuzzing | Optional harness/AFL++ paths; requires the corresponding toolchain, execution setup and budget |
| Firmware | Optional extraction and MIPS/ARM-family Qiling emulation; not universal device emulation |
| Mach-O / PE | Recognizing or statically analyzing a file does not establish generic dynamic confirmation support; broader execution expansion remains parked |
| Kernel / IOKit | Static leads require the appropriate separate kernel/VM proof workflow; they do not become confirmed userland findings |
| Windows specialist work | Driver/IOCTL analysis and external evidence contracts exist; these do not establish generic Windows execution or WinAFL support |
| Logic/authentication bugs | Hypothesis generation exists; there is no generic binary confirmation oracle |

### Entry points and readiness

The CLI delegates binary work to the separate 0verse environment:

```bash
0 binary ./program --mode triage
0 binary ./program --mode scan --backend ghidra
```

`triage` identifies the artifact; it does not decompile or prove vulnerabilities.
Scanning may perform substantially more work. The 0verse CLI scan default is
`llm=mock`, which is deterministic and is not real model analysis. Select and
configure an actual provider when requesting model-assisted analysis.

Browser conversations can attach the local 0verse MCP server when its checkout
and configured Python runtime are available. Its existing tools include:

- `get_capabilities`: catalog tools, scan schema and CLI-only capabilities.
- `list_bug_classes`: detection lenses and whether a generic oracle exists.
- `triage_binary`: identify an artifact without establishing a vulnerability.
- `preflight_binary`: check the requested artifact/profile and execution prerequisites.
- `scan_binary`: bounded scan with typed backend, profile, model and budget options.
- `list_findings`, `get_pov`, `get_report`: inspect retained results and evidence.

MCP scans also default to `llm=mock`. Choosing `confirmation` or `fuzz` does not
grant execution authority or install missing dependencies. Some advanced
Windows, Hyper-V, browser and firmware operations remain CLI-only.

The separate core agent tool `analyze_binary` is opt-in through
`ZERO_FEATURE_ZEROVERSE=1`; its presence and permissions are independent of MCP
attachment. It runs the versioned 0verse subprocess contract, not every advanced
research workflow. `0 doctor` checks general CLI/model prerequisites; it is not
a full Ghidra/fuzzer/VM qualification.

For exact setup, dependency versions, machine contracts and specialist limits,
see the repository's [0verse README](https://github.com/0sec-labs/0/blob/main/0verse/README.md),
[Ghidra setup](https://github.com/0sec-labs/0/blob/main/0verse/docs/GHIDRA-SETUP.md)
and [result contract](https://github.com/0sec-labs/0/blob/main/0verse/docs/RESULT-CONTRACT.md).

## Read the evidence basis

| Result | Meaning |
| --- | --- |
| Static candidate / hypothesis | Analysis found a plausible issue; runtime reproduction has not been established |
| Source-only confirmation | An independent verifier supports the source claim; it does not imply a PoC executed |
| Reproduced PoC / oracle evidence | The applicable reproducer ran and its evidence met the stated oracle |
| Unsupported / failed / skipped stage | The stage did not establish a result; this is not a clean bill of health |

The source engine separates verdict from evidence kind. In 0verse's machine
contract, `confirmed=true` specifically requires an attached reproduced PoV.
Keep these contracts distinct when combining results. A successful triage,
available backend or empty findings list alone does not prove a program secure.
