# 0 Tier-2 harness Makefile fragment — generated.
# Sanitizers: asan, ubsan

OSEC_TIER2_HARNESS := /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/.0/workflow-artifacts/2b6db022-de05-47c5-9601-979876f5bae6/tier2-prove_counterexample/harness
ZERO_TIER2_DEPS := \
  /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/.0/workflow-artifacts/2b6db022-de05-47c5-9601-979876f5bae6/tier2-prove_counterexample/harness.c \
  /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/patched-decoder.c \
  /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/src/decoder.c

$(OSEC_TIER2_HARNESS): $(ZERO_TIER2_DEPS)
	clang -O1 -g -fsanitize=address,undefined,fuzzer -fno-omit-frame-pointer -I/Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target -I/Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/include /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/.0/workflow-artifacts/2b6db022-de05-47c5-9601-979876f5bae6/tier2-prove_counterexample/harness.c /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/patched-decoder.c /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/src/decoder.c -o /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/.0/workflow-artifacts/2b6db022-de05-47c5-9601-979876f5bae6/tier2-prove_counterexample/harness

.PHONY: 0-tier2-run
0-tier2-run: $(OSEC_TIER2_HARNESS)
	/Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/.0/workflow-artifacts/2b6db022-de05-47c5-9601-979876f5bae6/tier2-prove_counterexample/harness -runs=200000 -max_total_time=300 -timeout=15
