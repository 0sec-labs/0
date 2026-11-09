# 0verse CVE evaluation — publication dates, localization and crash evidence (#49)

> **Historical evaluation, not proof of training-data exclusion.**
> The gate checks recorded publication dates against a declared comparison date.
> Real Codex runs contact an external model provider. The results below do not
> establish newly discovered CVEs or a false-positive rate on arbitrary codebases.

This historical evaluation uses five known, published CVE reproducer pairs.
It is a benchmark of source-pattern localization and executable crash evidence,
not evidence of newly discovered vulnerabilities or CVEs assigned to this project.

## Publication-date provenance gate

The corpus declares `2026-01-31` as a comparison date. Each real-CVE item records
an NVD URL, upstream fix reference and publication date.
`zeroverse.groundtruth.validate_post_cutoff()` checks that those fields are
present and the recorded publication date follows the declared date. The runner
refuses a failed gate unless `--no-cutoff-gate` is passed.

That check establishes a property of the recorded metadata. It does not inspect
model training data, independently verify a provider cutoff, or establish that
source code, vulnerability details or related patterns were unseen by the model.
A later public disclosure date alone cannot distinguish discovery from recall.
The gate and scorer are covered by `tests/test_cve2026.py`.

A reproducing PoV establishes the observed crash in the selected build. Matching
it to the known bug and distinguishing the fixed build are separate scoring
questions; neither establishes training-data exclusion.

## Methodology

* **Faithful standalone extracts.** Each item is a minimal C reproducer of the real
  upstream function: real function name, the real attacker→sink dataflow
  (`read(2)` → `memcpy`), and the **real upstream bound as the fix**, guarded by
  `#ifdef FIXED`. These are extracts, **not** full library builds (see Limitations).
  Provenance — CVE id, NVD URL, fix commit/advisory, publish date — is recorded in
  `benchmarks/cve2026/manifest.json` and `benchmarks/cve2026/provenance.json`.
* **Vulnerable + fixed pair.** Every CVE compiles to a *vulnerable* build and a
  *fixed* build (`-DFIXED`, the upstream patch). The fixed build is the
  **false-positive control**: any confirmed PoV on it is a false positive. We
  verified out-of-band (ASan) that every vulnerable build faults on a trigger input
  and every fixed build is clean before benchmarking.
* **Full pipeline, real model.** `zeroverse.api.scan` runs the whole CRS
  (ingest → decompile → slice → foxguard/bugclass lens → LLM reason → dynamic/PoV →
  fuzz). The LLM is the **real frontier model** via the operator's ChatGPT-OAuth
  Codex backend (`gpt-5.5`); no mock. These calls contact the model provider.
* **Same typed scorer** as the ground-truth eval (`zeroverse.groundtruth`):
  recall (located / confirmed), FP rate (confirmed / hypothesis), precision. Held-out
  by construction (every item `in_seed_set=false`).

## Corpus provenance (5 CVEs · 10 builds)

| CVE | Library | Function | Class | Published | NVD | Upstream fix |
|-----|---------|----------|-------|:---------:|-----|--------------|
| **CVE-2026-6192** | OpenJPEG | `opj_pi_initialise_encode` | int-overflow → OOB write (CWE-190) | **2026-04-13** | [link](https://nvd.nist.gov/vuln/detail/CVE-2026-6192) | commit [`839936aa`](https://github.com/uclouvain/openjpeg/commit/839936aa33eb8899bbbd80fda02796bb65068951) |
| **CVE-2026-32740** | libheif | `copy_image_to` | heap OOB write (CWE-787) | **2026-05-19** | [link](https://nvd.nist.gov/vuln/detail/CVE-2026-32740) | [GHSA-frfr-f3vg-2g6j](https://github.com/strukturag/libheif/security/advisories/GHSA-frfr-f3vg-2g6j), fixed v1.22.0 |
| **CVE-2026-8461** ("PixelSmash") | FFmpeg | `magy_decode_slice` | heap OOB write (CWE-787) | **2026-06-18** | [link](https://nvd.nist.gov/vuln/detail/CVE-2026-8461) | FFmpeg commit `374b726f` (shipped 8.1.2) |
| **CVE-2026-58049** | FFmpeg | `decode_dlta` | heap OOB write (CWE-787) | **2026-06-27** | [link](https://nvd.nist.gov/vuln/detail/CVE-2026-58049) | `libavcodec/rasc.c` byte-unit bound ([VulnCheck](https://www.vulncheck.com/advisories/ffmpeg-out-of-bounds-write-in-rasc-decoder-decode-dlta)) |
| CVE-2026-4775 | libtiff | `putcontig8bitYCbCr44tile` | signed int-overflow → OOB write (CWE-190) | 2026-03-24 ⚠ | [link](https://nvd.nist.gov/vuln/detail/CVE-2026-4775) | [Red Hat RHSA](https://access.redhat.com/security/cve/CVE-2026-4775), `tif_getimage.c` |

⚠ libtiff is Q1-tail (Mar 2026): after the declared comparison date, but the four Q2
CVEs have later recorded publication dates; this does not establish training exclusion.

The CVEs were selected after rejecting any that could not be confirmed against **both**
an NVD entry **and** a real upstream fix reference — the project has previously been
burned by hallucinated, AI-aggregator-only CVE ids, so unverifiable candidates were
dropped.

## Results — the real numbers (Codex / `gpt-5.5`, full pipeline)

Two independent runs on two decompiler backends. Both are reported (no
cherry-picking); the spread is real run-to-run variance (stochastic fuzzing + LLM).

| metric | Ghidra backend | rizin backend |
|--------|:--------------:|:-------------:|
| vulnerable / clean items | 5 / 5 | 5 / 5 |
| **recall (located at correct function)** | **80% (4/5)** | **80% (4/5)** |
| recall (confirmed PoV, *function-localized*) | 0% (0/5) | 20% (1/5) |
| **program-level reproduction** (vuln builds with a reproducing PoV) | **40% (2/5)** | **60% (3/5)** |
| **FP rate (confirmed PoV on fixed builds)** | **0% (0/5)** | **0% (0/5)** |
| FP rate (hypothesis-only noise on fixed builds) | 100% (5/5) | 20% (1/5) |
| Unmatched confirmed findings (scorer FP labels) | 2 | 2 |
| Finding-level confirmed precision | 0/2 (0%) | 1/3 (33.33%) |

### How to read this honestly

* **Localization is strong and stable: 4/5.** The static + foxguard + LLM lens put a
  finding on the *correct upstream function* for OpenJPEG, libheif, FFmpeg-MagicYUV
  and libtiff in both runs. **FFmpeg-RASC `decode_dlta` was missed in both runs** —
  its delta-run loop did not surface a clean source→sink slice. Reported as a miss.
* **Program-level reproductions and localization differ.** Two Ghidra and three
  rizin vulnerable builds have a confirmed finding, while zero and one,
  respectively, match the scorer's expected function. These are results on
  standalone extracts of known bugs, not new vulnerability discoveries.
* **Fixed-control item FPR is 0/5 in each run.** No fixed build produced a
  confirmed finding. This small control result is not an overall finding-level
  false-positive rate or a measured rate on arbitrary real codebases.
* **Finding-level precision is separately scored.** Each run contains two
  unmatched confirmed findings, including whole-program-attributed crashes.
  The retained scorer counts them as `confirmed_fp_findings`: Ghidra precision is
  0/2 and rizin precision is 1/3. Those labels include localization failures;
  changing their interpretation requires evidence and a reviewed scoring rule,
  rather than silently treating all confirmations as true positives.
* **Hypothesis-noise on fixed builds is high (up to 5/5 with Ghidra).** The fix is a
  *guard*; the `memcpy` sink still exists in the patched source, so the static/LLM
  lens raises the same hypothesis on the fixed build. These are **hypothesis-level,
  not confirmed** — no PoV reproduced — but they show the static lens alone cannot
  separate vulnerable from fixed; only the PoV stage does (and it does, cleanly).

Retained scored receipts: [Ghidra](../benchmarks/cve2026/results-codex-ghidra.json)
and [rizin](../benchmarks/cve2026/results-codex-rizin.json). The second receipt
records `backend: "auto"`; the historical rizin label is the campaign description,
not a newly verified backend identity.

## Limitations (read before quoting a number)

* **Faithful extracts, not full builds.** Each item models the real function, its
  real source→sink path and the real fix, but is a standalone reproducer — not the
  shipping OpenJPEG/libheif/FFmpeg/libtiff binary. It measures whether 0verse finds
  *the known bug's pattern in selected code*, not end-to-end whole-library triage.
  libheif's function is originally C++ (`pixelimage.cc`); it is extracted as C.
* **Publication dates do not establish training exclusion.** See the provenance gate above.
* **Fuzz confirms are whole-program-attributed**, deflating the strict
  function-localized recall — see above.
* **Stochastic.** Two runs differ (libtiff was a function-localized `confirmed-find`
  on rizin, only program-level on Ghidra). Treat single-run cells as samples.
* **Publication dates vary.** libtiff is recorded in March and four cases in Q2;
  neither group carries a training-exclusion guarantee.

## Reproduce

```bash
# real model, full pipeline, post-cutoff gate enforced:
python benchmarks/cve2026/run.py --llm codex \
    --out benchmarks/cve2026/results-codex.json
# a single CVE pair:
python benchmarks/cve2026/run.py --llm codex \
    --only ffmpeg_magicyuv_vuln ffmpeg_magicyuv_fixed
# deterministic offline floor (no model, no sends):
python benchmarks/cve2026/run.py --llm mock
```

The post-cutoff provenance gate, the manifest loader and the scorer reuse are
unit-tested in `tests/test_cve2026.py` (`pytest -q tests/test_cve2026.py`).
