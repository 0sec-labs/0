# Cryptographic dependency posture

Reviewed 2026-10-27 for the Ed25519-only Windows token-capture artifact.

`ssh-key` deliberately disables its default features and enables only `ed25519`
and `std`. Our `ci-system-test` feature does not enable extra cryptographic
backends. `cargo tree --locked --all-features --target all --edges normal,build`
contains neither `rsa` nor `crypto-bigint` (nor P-256/P-384/P-521).
Cargo.lock retains those optional dependencies; their presence is not evidence
that they are compiled into this artifact. Do not delete lockfile entries or
force incompatible transitive versions to make a lockfile-only report disappear.

- [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)
  has no patched `rsa` release. RSA is disabled here and the authorization
  policy rejects every algorithm except Ed25519 before verification.
- [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html)
  is fixed in `crypto-bigint >=0.7.6`; the older optional backend is not compiled
  here. Adding RSA or an elliptic-curve backend requires reassessing this graph.
- The [upstream maintainer advisory for GHSA-qwgh-2vcv-g2f7](https://github.com/RustCrypto/utils/security/advisories/GHSA-qwgh-2vcv-g2f7)
  affects `block-buffer >=0.11.0,<0.12.1`. The current `0.10.4` is outside that
  range. Unlike the affected inline-cursor design,
  [its source](https://github.com/RustCrypto/utils/blob/block-buffer-v0.10.4/block-buffer/src/lib.rs)
  stores `pos: u8` separately from the input buffer. The broader reviewed
  GitHub advisory range omits this lower bound. A regression test exercises the
  upstream compression-panic scenario against the resolved dependency.

This is a reachability/version assessment, not a claim that the affected
upstream versions have been patched. Keep the normal cargo-deny advisory check;
there are no advisory exceptions for these findings. Reassess on feature or
upstream dependency changes. `cargo test --locked --all-features` checks the
feature graph, the panic control, and the existing OpenSSH signing round trip.
