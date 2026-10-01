#!/usr/bin/env bash
set -euo pipefail

OUT="0-arxiv-source.tar.gz"

rm -f "$OUT"

tar -czf "$OUT" \
  "0-submission.tex" \
  "0-submission.bbl" \
  "refs.bib" \
  "generated/evidence-tables.tex" \
  "evidence/manifest.json" \
  "evidence/claim-map.json"

echo "Wrote $(pwd)/$OUT"
