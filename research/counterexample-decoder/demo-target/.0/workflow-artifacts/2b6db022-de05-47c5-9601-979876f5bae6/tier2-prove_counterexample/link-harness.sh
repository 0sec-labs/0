#!/usr/bin/env bash
# 0 Tier-2 linker helper — generated.
#
# Sanitizers: asan, ubsan
# Output binary: /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/.0/workflow-artifacts/2b6db022-de05-47c5-9601-979876f5bae6/tier2-prove_counterexample/harness
#
# This script just runs the canonical compile command. Use it as a
# starting point; production builds may want to integrate the linker
# step into the host project's own build system instead.
set -euo pipefail

clang -O1 -g -fsanitize=address,undefined,fuzzer -fno-omit-frame-pointer -I/Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target -I/Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/include /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/.0/workflow-artifacts/2b6db022-de05-47c5-9601-979876f5bae6/tier2-prove_counterexample/harness.c /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/patched-decoder.c /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/src/decoder.c -o /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/.0/workflow-artifacts/2b6db022-de05-47c5-9601-979876f5bae6/tier2-prove_counterexample/harness

echo "[0 tier-2] harness built: /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/.0/workflow-artifacts/2b6db022-de05-47c5-9601-979876f5bae6/tier2-prove_counterexample/harness"
echo "[0 tier-2] to run:  /Users/peak/coding/0sec-labs/0/research/counterexample-decoder/demo-target/.0/workflow-artifacts/2b6db022-de05-47c5-9601-979876f5bae6/tier2-prove_counterexample/harness -runs=200000 -max_total_time=300 -timeout=15"
