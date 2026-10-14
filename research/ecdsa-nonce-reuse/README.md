# Two signatures, one reused nonce, a fresh forgery

This is a known ECDSA nonce-reuse attack against a deliberately broken signer
using an ephemeral, locally generated P-256 key. It is a calibration demo for
proof-assisted security research, not a new vulnerability, a break of P-256,
or a defeat of TLS. There are no external targets or production key inputs.

Run with Node 20 or newer:

```sh
node research/ecdsa-nonce-reuse/demo.mjs
```

The script generates two distinct signed messages using the same nonce,
recovers the signing scalar from their public signatures and hashes, and
signs a third fresh message using the recovered scalar. Node's independent
OpenSSL verifier must accept all three signatures against the ORIGINAL
public key and reject a changed third message. Public-key equality supplies
an additional check. A successful run writes `result.json` and prints five
verification booleans. No private scalar or nonce is explicitly serialized;
the first two public signatures deliberately make that ephemeral key
recoverable. Each run replaces the result with fresh local data.

All parameters are fixed to P-256. Scalar multiplication uses 256 iterations,
inversion is capped at 1024 iterations, and random scalar sampling is capped
at 128 attempts. The code uses only Node built-ins. It is variable-time,
handwritten teaching code and must not be used for real signing. It contains
basic point/domain sanity checks; independent OpenSSL verification is the
main executable cross-check.

## The exact algebra

ECDSA gives, modulo the prime subgroup order n:

```
s1*k = z1 + r*d
s2*k = z2 + r*d
k = (z1-z2) / (s1-s2)
d = (s1*k-z1) / r
```

Division means multiplication by a modular inverse. Recovery requires
nonzero r and nonzero s1-s2. The demo does not normalize signature s values,
and deliberately reuses exactly the same nonce. Equal r values alone are
not a general assertion that arbitrary signatures used an identical nonce.

`Recovery.lean` states the algebra over any field and supplies a Mathlib proof.
Its checking status is recorded separately by the integration workflow;
the Node runtime result by itself does not establish Lean acceptance. Even
when Lean accepts it, the theorem proves algebra under the listed assumptions,
not the correctness of this JavaScript implementation, the entire ECDSA
scheme, or TLS.

Observed check: the exact theorem passed in the official Lean playground on
v4.35.0-rc4 with Mathlib. `#print axioms nonce_reuse_recovery` reported only
`propext`, `Classical.choice`, and `Quot.sound`; no proof errors or warnings were
shown. `verification.json` retains the source hash and actual axiom report.
This is a recorded checker observation, not an independent Comparator
certificate or a pinned local Mathlib build.

## Why this makes a useful security demo

It connects a precise mathematical failure condition to a concrete forgery
accepted by an independently implemented verifier. Zero could use it to
calibrate its claim/proof/reproduction evidence pipeline. Future research
would identify such violated invariants in owned or authorized implementations
and link them to realistic execution paths, rather than declaring a protocol
broken from a simplified model.

The ECDSA generation and verification equations are standardized in
[NIST FIPS 186-5, section 6](https://csrc.nist.gov/pubs/fips/186-5/final).
The curve parameters are specified in
[NIST SP 800-186](https://csrc.nist.gov/pubs/sp/800/186/final).
