---
title: Blind Verification
description: Workflow-specific agent verification, its evidence limits, and the distinction from deterministic replay.
---

0 separates discovery from verification on several assessment paths. A fresh
agent context reduces shared conversational bias; it does **not** guarantee a
different model, an information-blind prompt, or successful reproduction of every
reported finding. See [Scan Workflows](/scan-workflows/#verification-and-evidence)
for selecting a workflow.

## What it is

The verifier input and decision contract depend on the caller:

| Path | Verifier receives | Execution and limits |
| --- | --- | --- |
| Native agentic scan | One finding's ID, title, category, severity, request/response excerpts, original analysis excerpt, target and authentication context; optional prior human-review context | Separate session per finding, **5 turns** each; tools replay the claim and `update_finding` records a decision |
| Legacy agentic scan | A list of titles, severities, categories and request/response excerpts plus target/authentication | Shared session, `min(findingCount * 3, 15)` turns |
| Template scan (`stages/blind-reexploit.ts`) | Template name/category, payload and response (500 characters each), target | Available API runtime: one combined session with `max(10, itemCount * 4)` turns; otherwise the fallback below |
| Structured verification | Finding and target in four model prompts; optional historical review context | Model assessment **without tools**, not an executable replay |
| Source review / hunt | Source-specific review or configured skeptic/prover gates | May establish source-backed plausibility without running the vulnerable program |

The native scan prompt includes up to 1,000 characters each of the original
request and response and 600 of analysis. It does not receive the original full
conversation, but it is not blind to the finding's reasoning. Do not describe
all these paths as a verifier seeing only a PoC and target.

<span id="why-it-matters"></span>
## Confirmation bias

A separate pass can investigate:

- **Refusal misclassification:** the target echoes an instruction while refusing it.
- **Non-deterministic responses:** an apparent failure disappears on retry.
- **Context-dependent payloads:** an attack needs earlier conversation setup.
- **Partial compliance:** text suggests success without the claimed data leak or action.

Inspect the actual request, response, tool output and assertions. A model verdict
or confidence score alone is not runtime evidence, and retry failure does not
prove that a vulnerability is absent.

## How it works

### Finding lifecycle

`save_finding` records a candidate, not independent proof. On the agentic scan
path, the verifier is instructed to replay the attack, try variations, and call
`update_finding` with `confirmed` or `false-positive`. A stopped or exhausted
session need not decide every candidate. Triage guards can retain protected
findings for further investigation rather than silently suppressing them.

Automated verification, `triageStatus`, and human acceptance/suppression are
separate signals. Read the retained evidence and triage provenance rather than
assuming every row in a report has passed every gate.

### Agentic verification (with API key)

The template-scan implementation attempts to construct an available
`LlmApiRuntime`; availability, not merely the presence of an environment
variable, selects this branch. Its verify agent re-sends attacks and uses
`save_finding` to record fresh evidence. The stage matches confirmations by
**template ID**, filters its in-memory findings accordingly, and adds newly
confirmed findings. This is not an exact per-payload reconciliation.

When the database supports verdict persistence, it records `TRUE_POSITIVE`
(confidence `0.8`) or `FALSE_POSITIVE` (`0.7`) against the matched finding.
Those values are fixed stage labels, not calibrated reproduction probabilities;
persistence is best-effort. This contract is distinct from the per-finding
`update_finding` path above.

### Heuristic fallback (no API key)

When the template stage cannot obtain an available API runtime:

- A known template with **two or more** vulnerable attack results produces a
  confirmed finding; a single result increments the false-positive count.
- Existing `discovered` findings are promoted to `confirmed` without another
  agent run. The implementation intends this for deterministic web/MCP checks,
  but the loop does not independently prove every such finding's origin.

This fallback does **not** replay the payload. A `confirmed` lifecycle label on
this path must not be presented as independent reproduction.

### Structured verification and memories

The four structured steps assess reachability, payload validity, impact and
exploit confirmation using model responses. They call the runtime with an empty
tool list. A failed or unparseable step returns `rejected`; optional consensus
repeats these assessments, not live exploits. The agentic scan's consensus gate
is opt-in and precedes its tool-using verifier.

Prior human-review memories are explicitly untrusted context, not proof or
instructions. Opt-in [Jev memory ranking](/features/#advisory-evaluations) can
reorder relevant memories; it cannot reject a finding or promote it to verified.
Jev duplicate assessment likewise groups report rows without supplying a new
verification result.

## What gets killed

Filtering depends on the workflow, target and enabled gates. Historical
false-positive reductions are not a universal removal rate. A rejected finding
can reflect negative evidence, a model judgment, insufficient evidence or a
failed parsing step; those are different reasons to investigate.

For source-only candidates, preserve the deployment assumptions and missing
runtime prerequisites. For live-target claims, retain identity/authorization
controls and evidence of the actual effect, not only a successful HTTP status.

## Comparison

| Approach | What it establishes |
| --- | --- |
| Tool-using agent verification | A fresh attempt, whose observed evidence still needs inspection |
| Structured model assessment / consensus | Model judgments of the supplied evidence |
| Template heuristic fallback | Multiple vulnerable-response labels or promotion of existing discoveries, without a new replay |
| Deterministic replay | Declared executable steps and assertions evaluated by a selected runner |
| Research evidence envelope | Path-specific proof grade, provenance and any required novelty/privilege receipts |

[Deterministic replay results](/verification-result/) use a separate JSON schema.
Kernel verification, agent-action assurance and reproduction bundles have their
own result contracts. Verification adds runtime and model cost; missing tooling,
a skipped check or an unavailable evaluator leaves uncertainty, not proof of safety.
