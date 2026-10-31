# Worker demo target — decoder allocation truncation

Synthetic, deliberately vulnerable C library shipped with the CLI for worker
deployment and counterexample workflow demos. `patched-decoder.c` is the reference
mitigation; `witness-65537x1.bin` is the replay input.

The CLI bundle copies this directory to `worker-assets/demo-target`. Source
checkouts use this directory directly; neither path requires the research tree.

The bug in `src/decoder.c::decode_payload` is the same shape as the
18-year-old integer-truncation flaw described in the Provos /
IronCurtain post (Apr 2026): unchecked arithmetic on attacker-controlled
lengths feeds a `malloc` size, and a 32-bit multiplication wrap returns
a tiny allocation that a subsequent `memcpy` then overflows.

A tier-1 libFuzzer harness against `decode_payload` should trip
AddressSanitizer within seconds.

**Do not use this code anywhere. The bugs are intentional.**
