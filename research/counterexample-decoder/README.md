# Counterexample demo: decoder allocation truncation

Falsification-first calibration demo. A bounded search finds a minimal input
that violates a stated safety property of the deliberately vulnerable decoder
fixture; the witness is then replayed against the real build under
AddressSanitizer and against a reference mitigation.

```
node research/counterexample-decoder/demo.mjs   # writes result.json
```

## What it demonstrates

1. **Search (model):** property `for every accepted input, copyBytes <= allocBytes`.
   Enumerates `count 1..2048 × elementSize 1..256` (524,288 candidates), keeps
   inputs the fixture accepts but where the 16-bit-truncated allocation is
   smaller than the copy length. 323,466 violations found.
2. **Minimal witness:** `count=256, elementSize=256` → copies 65,536 bytes into
   a 1-byte allocation.
3. **Implementation replay:** vulnerable build aborts with
   `heap-buffer-overflow decoder.c:46`, `WRITE of size 65536`.
4. **Mitigation replay:** same witness against `patched-decoder.c` exits 0 with
   no sanitizer finding; an under-supplied payload is cleanly rejected (-1).

Evidence is source-bound: `result.json` records SHA-256 of both the vulnerable
fixture source and the mitigation source, the exact witness parameters, exit
codes/signals, and sanitizer summary lines.

## Scope

- The vulnerability is intentional and documented in the fixture. This validates
  the search → witness → replay → mitigation evidence path. **Not a new
  discovery.** Novel impact requires applying the same path to code or
  configurations whose failure is not already known.
- Model violation, ASan observation, and mitigation validation are recorded as
  separate evidence. None silently stands in for the others.
- The vulnerable fixture is never modified; `patched-decoder.c` lives only in
  this directory.
