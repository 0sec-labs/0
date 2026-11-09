# 0verse ground-truth evaluation — does it find REAL bugs without crying wolf?

> **Historical campaign record.** Preserve the measured tables and their
> target/model/budget limitations. “Now,” “headline,” and reproduction host
> aliases below refer to this campaign, not the current checkout's qualification.
> A new run needs separately installed engines, authorized execution, and
> provider credentials; see [INTEGRATION.md](INTEGRATION.md).

> **The credibility instrument.** Everything else measures 0verse against *itself*
> (ablations, baselines). This measures it against **ground truth**: real bugs with
> KNOWN locations + fix commits, scored for **reach** / **recall** (did it surface
> the bug at the right function/sink, with a reproducing PoV?) and **FP rate** (does
> it confirm bugs on the *fixed* / clean builds?).
>
> The **headline** number is the **real-LLM** run on **Magma** — real upstream
> libraries (libpng / libxml2 / libtiff / lua / sqlite3 / libsndfile ...) carrying
> real, catalogued CVE-class bugs at scale. The small real-CVE-reproducer corpus
> below it is a **held-out sanity / regression set**, *not* the capability claim.
> The deterministic **MockLLM** run is the **CI regression floor** — it proves the
> harness wiring + static lenses still fire with no keys/network, and is **never a
> capability number**.
>
> The Magma summary below names its retained JSON receipts explicitly. The
> `zeroverse.magma` and `zeroverse.groundtruth` scorers define their metrics.
> Keep missing controls, misses and unmatched confirmations visible.

## What's measured

PoV-is-truth, ASSUME-FP, carried through both corpora:

| metric | definition |
|--------|------------|
| **reached** | the bug's function was *surfaced* by a finding (slice/lens), PoV or hypothesis — coverage, not a confirmation |
| **confirmed (recall)** | the **oracle reproduced a PoV** at the right function (a fatal-canary abort or a sanitizer crash) — never an LLM's say-so |
| **confirmed-PoV rate** | of the *reached* bugs, the fraction that reached a reproducing PoV (vs stayed a hypothesis) |
| **FP — confirmed** | a confirmed PoV that lands on **no** catalogued bug (unmatched), or **any** confirmation on a *fixed* build — the serious false alarm (should stay ~0) |
| **precision (confirmed)** | over all *confirmed* findings, the fraction landing on a real bug at the right place |

The scorers are pure + typed (`mypy --strict`) and unit-tested against fixture
ground truth (`tests/test_magma.py`, `tests/test_groundtruth.py`) — the reach /
recall / FP / precision math, the catalogue + manifest loaders, the held-out
tagging, and the `MAGMA_`-symbol-prefix normalization — no Ghidra/Docker needed to
test the math.

---

## Retained Magma runs — real LLM, instrumented upstream libraries

Three checked-in runs cover the same five targets (`lua`, `libpng`, `libsndfile`,
`libxml2`, `libtiff`), 53 distinct scorable bug-sites and 60 catalogued bugs.
They use Codex, Ghidra and fatal-canary instrumented fuzz drivers. These are
historical measurements, not a current release qualification.

| Retained receipt | Sites reached | Sites confirmed | Unmatched confirmations | Clean targets | Successful / failed model calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Run 1](../benchmarks/magma/results-magma-run1.json) | 8/53 | 4/53 | 0 | 0 | 62 / 0 |
| [Run 2](../benchmarks/magma/results-magma-run2.json) | 8/53 | 4/53 | 0 | 0 | 65 / 0 |
| [Run 3](../benchmarks/magma/results-magma-run3.json) | 7/53 | 3/53 | 0 | 0 | 64 / 0 |

The median is 8 reached and 4 confirmed sites, with confirmations ranging from
3 to 4. Each receipt records measured token usage and `complete: true` for its
five planned targets. A zero unmatched-confirmation count is a finding-level
observation against this catalogue. **Clean-control FPR is unmeasured: none of
these three runs includes a clean or fixed target.** Their
`clean_confirmed_fp: 0` field has a zero clean-target denominator and must not be
reported as a measured 0% FPR.

Confirmation uses an existing fuzzable instrumented target, not an arbitrary
stripped binary. These runs do not establish false-positive rates on arbitrary
real codebases, current operational success, or newly discovered Linux zero-days.
The catalogue, per-target scores, hypotheses, infrastructure notes and model
accounting remain in the linked receipts. See [BENCHMARKS.md](BENCHMARKS.md) for
the separate fuzzing comparison; its budget and trial count must stay attached.

The earlier partial-run narrative referenced `results-magma-codex.json`, which is
not retained in this checkout. Its table is superseded here by the three actual
receipts above; it must not be used as an independently reproducible measurement.

---

## Held-out sanity / regression set (NOT the capability claim)

A small labeled corpus that runs in minutes and is checked into the repo. Its role is
**regression + held-out sanity** — to catch a lens/oracle regression and to show a
generic lens *generalizing* to a real CVE instance — **not** to state capability.
Manifest: `benchmarks/groundtruth/manifest.json` (14 items: 9 vulnerable / 5 clean).

### Tier 1 — held-out real-CVE reproducer pairs (`in_seed_set=false`)

Faithful **standalone extracts** of real upstream vulnerable functions (real name,
real sink, real upstream fix), built BOTH **vulnerable** and **fixed** (`-DFIXED`).
The fixed build is the FP probe.

| id | CVE | CWE | function | upstream |
|----|-----|-----|----------|----------|
| `cve_2004_0597_png_{vuln,fixed}` | CVE-2004-0597 | CWE-120 | `png_handle_tRNS` | libpng |
| `cve_2017_9047_xml_{vuln,fixed}` | CVE-2017-9047 | CWE-787 | `xmlSnprintfElementContent` | libxml2 — **== Magma XML001** |
| `cve_2012_0809_sudo_{vuln,fixed}` | CVE-2012-0809 | CWE-134 | `sudo_debug` | sudo |

These bug instances were **never used to build any 0verse detector** (the lenses are
generic CWE patterns; the one variant seed is macOS IOKit), so a find reads as
generalization. `cve_2017_9047` *is* Magma **XML001** — independent corroboration
that the reproducer tracks a real, catalogued bug.

### Tier 2 — sanity floor (0verse's own fixtures; `in_seed_set=true`)

The `benchmarks/*.c` synthetic fixtures + two clean look-alikes. Explicitly **not**
held-out evidence — the floor that proves the harness wiring works end to end.

### The MockLLM run is the CI **regression floor** — NOT a capability measure

The deterministic `MockLLM` lane (no keys, no network, runs in CI) is the
**`ci-regression-floor (NOT a capability measure)`** lane. `format_report` stamps that
banner on its output and `results.json` carries `"capability_measure": false`, so a
MockLLM percentage **cannot be misread as performance**. It exists only to detect a
regression in the static lenses + oracle wiring. The runner now **defaults to the
real LLM** (`--llm codex`); `--llm mock` prints a loud floor warning.

> **Lane: `ci-regression-floor (NOT a capability measure)`** · `results.json`
> (`capability_measure: false`), `bench`, Ghidra, x86-64 ELF, 14 items (2026-06-28):

| metric (14-item set) | MockLLM **regression floor** |
|---|:--:|
| recall — confirmed PoV | 67 % (6/9) |
| recall — located (PoV *or* hypothesis) | 100 % (9/9) |
| FP — confirmed on clean/fixed builds | **0 %** (0/5) |
| precision — confirmed findings | 100 % |

_This number's **only** job is to fail CI if a lens/oracle regresses (e.g. the floor
drops). It is **not** a capability measure — it runs with no keys/network and no
frontier reasoning. The capability claim is the **Magma headline above**; the
real-LLM (`gpt-5.5`) run on this same small set (`results-codex.json`) is the
*sanity* ceiling, not the headline._

> The real-LLM lane on this small set is the *sanity* ceiling, not the headline; the
> headline is Magma above. The earlier revisions of this doc presented a MockLLM
> percentage on these 14 items as the result — that was a sanity check mis-presented
> as a capability number, and is corrected here.

---

## Reproduce

```bash
ssh bench
export GHIDRA_INSTALL_DIR=/opt/ghidra
# --- Magma at scale (the headline), real LLM (Codex gpt-5.5 via ChatGPT-OAuth) ---
# 1. build a target with fatal canaries, -O0 (aflplusplus image):
docker build -t magma/aflplusplus/libpng:isan \
  --build-arg fuzzer_name=aflplusplus --build-arg target_name=libpng \
  --build-arg USER_ID=1000 --build-arg GROUP_ID=1000 \
  --build-arg canaries=1 --build-arg isan=1 -f magma/docker/Dockerfile magma/
# 2. scan + score (extracts the driver from the image, runs the full pipeline):
python benchmarks/magma/run.py --targets libpng lua libxml2 libtiff \
    --llm codex --out benchmarks/magma/results-magma-codex.json

# --- held-out sanity / regression set ---
python benchmarks/groundtruth/run.py --llm codex \
    --out benchmarks/groundtruth/results-codex.json
# CI regression floor (deterministic, no keys — NOT a capability number):
python benchmarks/groundtruth/run.py --llm mock \
    --out benchmarks/groundtruth/results.json
```

The Magma output path in the reproduction command is a proposed new output, not
a checked-in receipt. The retained `results-magma-run1.json` through
`results-magma-run3.json` (schema `zeroverse.magma`, v1.0) and `results.json`
(schema `zeroverse.groundtruth`, v1.0) carry the full per-target/per-item findings +
the metrics block + the `lane` / `capability_measure` stamp.
