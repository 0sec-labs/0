# Shell-first rationale

Why 0 uses bash instead of structured tools, with A/B test data from the XBOW benchmark. Moved from the public docs site; the benchmark figures are historical single-challenge observations, not current claims.

> **Decision (2026-11):** the default tool list for Threads and Agents is now a small core with everything else behind skill-provided packs; see [Core toolset](core-toolset.md). The text below is the earlier single-challenge experiment.
>
> **Historical experiment and rationale.** The small A/B observations below are
> preserved, not a current universal performance claim or exhaustive tool list.
> Current workflows expose additional tools, and
> configurable executors; see [Architecture](architecture.md). Shell access is not automatically sandboxed.

Most AI security tools give agents structured tools with typed parameters -- `crawl(url)`, `submit_form(url, fields)`, `http_request(url, method, body)`. The agent must learn the tool API, choose the right tool, and compose multi-step operations across separate tool calls.

We built this. We tested it. It failed.

On the XBOW IDOR benchmark challenge, our structured-tools agent ran 20+ turns across multiple attempts and never extracted the flag. It could see the login form but couldn't chain the exploit: login with credentials, save the cookie, probe authenticated endpoints, escalate privileges, extract the flag.

Then we gave the agent a single tool: `bash`. Run any bash command. The agent wrote `curl` commands with cookie jars, decoded JWTs with Python one-liners, looped through IDOR endpoints with bash, and **extracted the flag in 10 turns. First try.**

<span id="why-shell-wins-for-pentesting"></span>
## Shell interface

LLMs have seen millions of curl-based exploits, CTF writeups, and pentest reports in training. Structured tools require learning a new API. With shell, the agent writes the command directly.

A single curl command handles login, cookies, redirects, and response parsing. With structured tools, that is 4 separate calls with state management. The agent can also run sqlmap, write Python exploit scripts, use jq, chain pipes.

<span id="the-0-tool-set"></span>
## The 0 tool set

| Tool | Purpose | When to use |
|------|---------|-------------|
| `bash` | Run any shell command | Primary tool for all pentesting |
| `save_finding` | Record a vulnerability | When you find something |
| `done` | Signal completion | When finished |
| `send_prompt` | Talk to AI/LLM apps | AI-specific attacks only |

The tool was renamed from `shell_exec` to `bash` to match [pi-mono](https://github.com/badlogic/pi-mono)'s naming convention. Simpler name, same capability.

Everything else (crawl, submit_form, http_request) is available but optional. The agent can choose structured tools or just use curl. We don't force a framework.

## Shell vs structured: the data

We built 10 structured tools (crawl, submit_form, http_request, etc.). Then tested against giving the agent just `bash`.

| Approach | XBOW IDOR (XBEN-005) | Turns | Flag |
|----------|----------------------|-------|------|
| Structured tools (10 tools) | Failed | 20+ | No |
| Shell only (bash) | Passed | 10 | Yes |
| Hybrid (both) | Inconsistent | 15-25 | Sometimes |

**Winner: bash only.** The model knows curl from training. Structured tools add cognitive overhead. Final tool set: `bash` + `save_finding` + `done`.

## Influences

- **[pi-mono](https://github.com/badlogic/pi-mono)** -- minimal coding agent -- bash is the primary tool. Bash is the Swiss army knife.
- **[Terminus](https://www.tbench.ai/news/terminus)** -- single tmux tool, 74.7% on Terminal-Bench.
- **[XBOW](https://xbow.com/blog/core-components-ai-pentesting-framework)** -- structured tools + real security tooling, 85%.
- **[KinoSec](https://kinosec.ai)** -- 92.3% on XBOW, black-box HTTP.
- **["Is Bash All You Need?"](https://arxiv.org/abs/2609.11999)** -- compares typed, typed plus bash, bash-only and programmatic interfaces; reports bash alone beating typed tools with fewer tokens (abstract read; sample sizes not verified).
- **[Vercel: we removed 80% of our agent's tools](https://vercel.com/blog/we-removed-80-percent-of-our-agents-tools)** -- vendor report, 5 queries, directional only.
- **[Anthropic: advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)** -- tool search over large tool libraries.
- **[Pi coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent)** and **[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)** -- small-core and bash-only agents.

An earlier version of this page cited arXiv 2509.09207 ("Shell or Nothing"). That paper is a pentesting system paper (TermiBench), not a bash-only comparison, so it was removed as support.

## A/B tests

### Prompt length: minimal vs playbook

Tested a 25-line minimal prompt against a 180-line prompt with bypass playbooks, encoding ladders, and mutation techniques (inspired by deadend-cli's 770-line prompt).

| Prompt | Challenge XBEN-079 | Findings | Flag |
|--------|-------------------|----------|------|
| Minimal (25 lines) | Failed | 0 | No |
| Playbook (180 lines) | Failed | 1 | No |

**Winner: no clear winner.** Playbook found 1 more vulnerability but extracted 0 more flags. The model already knows bypass techniques from training. We went back to the minimal prompt.

### Reasoning effort: default vs high

Tested Azure gpt-5.4 with `reasoning_effort: "high"` (previously running on default/medium).

| Challenge | Default reasoning | High reasoning |
|-----------|------------------|----------------|
| XBEN-036 (easy) | FLAG, 5 turns | FLAG, 5 turns |
| XBEN-042 (hard) | FAIL | FAIL (25 turns, 417s) |
| XBEN-092 (medium) | FAIL | FAIL (14 turns, network error) |

**Verdict: high reasoning doesn't help.** Same results on easy challenges, same failures on hard ones. Just slower and more expensive.

### Concurrent subagents

The lead agent can spawn concurrent subagents via `spawn_agents` to fan out across independent hypotheses or endpoints, each in a fresh context, and merge their results back.

**Verdict: shipped.** An early single-shot `spawn_agent` prototype went unused because the agent preferred to stay in bash, so we reworked it into a concurrent fan-out primitive. In that form it earns its keep on targets with a broad attack surface, where exploring branches in parallel beats a single linear run. See the XBOW notes for how the fan-out is used alongside compaction, loop detection, and retry/handoff.

### Tool router hook

Catches unknown tool names (e.g., if the model calls "nmap") and routes to bash.

**Verdict: never triggered.** With only 3 tools, the model doesn't hallucinate tool names.

### Multi-checkpoint budget awareness

Replaced single 60% reflection with graduated checkpoints at 30%, 50%, 70%, 85%. Inspired by Cyber-AutoAgent's phased plan evaluation.

| Challenge | Before (single 60% reflection) | After (multi-checkpoint) |
|-----------|-------------------------------|--------------------------|
| XBEN-092 | 9 turns, 1 finding, stalled | 21 turns, 0 findings, active until timeout |

**Verdict:** Agent stays active longer and doesn't stall as early. But doesn't crack new challenges -- the hard failures need stronger model reasoning, not better prompting.
