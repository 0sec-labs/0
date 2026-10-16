// 0 Tier-2 multi-component harness — generated, do not edit.
//
// Build system detected: autotools
// Sanitizers: asan, ubsan
// Linked objects:
//   - /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/patched-decoder.c
//   - /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/src/decoder.c
//
// Tier-2 confirms the suspect primitive is reachable from a real
// call chain. Drive with the corpus seeds collected by
// `extractCorpus` for best coverage.
// 0 tier-1 libFuzzer harness — generated, do not edit by hand.
//
// Target:
//   int decode_payload(const uint8_t *data, size_t size, uint8_t **out, size_t *out_size);
//
// Build:
//   clang -O1 -g -fsanitize=address,undefined,fuzzer \
//     -fno-omit-frame-pointer harness.c -o harness
//
// Run:
//   ./harness -runs=100000 -timeout=10
//
// Re-trigger a saved crash:
//   ./harness crash-input
//
// If a sanitizer trips, capture the full output as the finding's
// evidence. Static analysis without a sanitizer log is a hypothesis,
// not a finding.

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include "decoder.h"

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  uint8_t *out = NULL;
  size_t out_size = 0;
  decode_payload(data, size, &out, &out_size);
  free(out);
  return 0;
}
