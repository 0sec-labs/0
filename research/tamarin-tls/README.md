# Local replay research lab

This is a controlled replay demonstration and a starting point for formal security research. It is not a new TLS vulnerability or a claim to have broken cryptography.

## Run the actual implementation demo

```sh
node research/tamarin-tls/https-replay-lab.mjs
```

Requirements: Node with TLS 1.3 support and `openssl` on PATH (LibreSSL works for generating the test certificate).

The script generates a temporary self-signed certificate, trusts that certificate explicitly on the client, and binds four HTTPS services exclusively to `127.0.0.1` on ephemeral ports. It sends the same owned application ticket to two logical services. With independent local consume caches both services accept it (HTTP 200 twice); replay to either used cache is rejected (409). With a shared synchronous consume operation only one of the two concurrent requests succeeds; all subsequent attempts are rejected. Assertions check negotiated TLS 1.3, response statuses and side-effect counts. The servers and temporary certificate/private key are cleaned in a `finally` block. There are no external target inputs.

Observed run: `https-replay-trace.json` records two accepted side effects with local caches and one with shared consume. Requests were sent **after the TLS handshake**. This demonstrates an application replay/idempotency hazard over actual HTTPS. It does **not** establish TLS early-data / 0-RTT replay behavior. The ticket is an application bearer token, not a TLS session ticket.

The shared Set is atomic only within this single Node process because check-and-add is synchronous. A production distributed implementation needs an equivalent atomic datastore operation plus explicitly modeled expiry, crash, retry and side-effect ordering. It cannot replace that operation with separate remote `GET` and `SET` calls. These examples guarantee at-most-once acceptance under their assumptions, not exactly-once completion.

## Run the symbolic models

```sh
node research/tamarin-tls/run-tamarin.mjs
```

The script probes `tamarin-prover` on PATH, gives each model 60 seconds, records raw proof logs and `tamarin-result.json`, and exits 2 on missing dependencies, timeouts, failures or absent/unexpected proof summaries. An exit-0 process is insufficient: the runner checks individual Tamarin lemma summary results. The models are fixed local files.

**Observed verification status:** Tamarin 1.12.0 and Maude 3.5.1 were fetched from official release/bottle sources into a temporary task directory, without a global installation. Both models were parsed and all four lemma outcomes below were observed. `tamarin-result.json` records `expected-results-confirmed`; raw logs contain the proof/counterexample summaries. Graphviz was not required for batch checking.

| Model | Lemma | Observed result |
| --- | --- | --- |
| `local-caches.spthy` | `distributed_replay_exists` | verified existence of a trace accepting the same ticket at nodes a and b |
| `local-caches.spthy` | `at_most_once` | falsified with a counterexample |
| `shared-consume.spthy` | `acceptance_exists` | verified existence of a successful acceptance (non-vacuity) |
| `shared-consume.spthy` | `at_most_once` | verified |

For this machine's temporary installation, the command actually used was:

```sh
PATH=/tmp/zero-tamarin-research-20261007/tamarin-prover/1.12.0/bin:/tmp/zero-tamarin-research-20261007/maude:$PATH node research/tamarin-tls/run-tamarin.mjs
```

Those temporary paths are not portable. For a durable setup, use the [official Tamarin installation instructions](https://tamarin-prover.com/manual/master/book/002_installation.html), or place official Tamarin and Maude binaries on PATH. The Maude runtime files remain together in the same extracted directory. The [official Maude 3.5.1 release](https://github.com/maude-lang/Maude/releases/tag/Maude3.5.1) supplied `Maude-3.5.1-macos-arm64.zip`.

Both models restrict issuance to one fresh ticket, have two node identities, and expose the ticket to the symbolic adversary to allow replay. The vulnerable model has two separate linear `Unused(node,ticket)` resources. The fixed model has one shared linear `Unused(ticket)` resource. Linear resources are consumed by a transition; persistent facts (`!Node`) remain available. This is an abstract acceptance-policy model. It contains no TLS handshake, encryption, key compromise, certificate logic, expiry, restart or distributed datastore failures. Tamarin can analyze much richer protocols; this toy model isolates a single property.

## What should run inside Zero?

Zero should orchestrate bounded jobs and retain evidence; each verifier should execute as a separate constrained process. Use:

- **Tamarin:** symbolic protocol traces, authentication/replay properties and counterexamples.
- **Lean:** precisely stated mathematical claims and invariants, with assumptions and axioms audited.
- **A real implementation fixture:** whether the suspected execution occurs in actual library/application behavior.

The loop is candidate claim → model → counterexample or proof → implementation replay → evidence review. Parallel agents can own separate candidate models and fixtures, but proof checking and replay should be independently rerun before accepting a finding. A model proof alone does not prove that implementation code satisfies it. This lab's correspondence is manually specified: a Tamarin accept action corresponds to a 200 response plus counter increment; a consumed linear fact corresponds to synchronously adding the application ticket to the appropriate Set. This mapping has not been mechanically proved.

Promote this to a Zero finding only when the claim, assumptions, model/tool versions, logs, relevant implementation revision and replay result are all retained. Missing tools and unfinished proofs must stay `inconclusive`. A Tamarin counterexample is evidence about the modeled system; a locally reproduced application flaw is evidence about this fixture. Neither proves an external deployment is vulnerable.

## Actual TLS 1.3 early-data calibration and next research step

The [early-data calibration](early-data/README.md) now runs a real OpenSSL 3.6.4 C harness using `SSL_read_early_data`, `SSL_write_early_data` and `SSL_get_early_data_status`. Run `node research/tamarin-tls/early-data/run.mjs`. With explicit anti-replay enabled, first early-data use is accepted and reuse of the original ticket is rejected while a full handshake succeeds. With anti-replay deliberately disabled, both early-data uses are accepted. Both configurations passed and [results are retained](early-data/result.json). This is documented behavior, not a newly discovered TLS break.

The OpenSSL 3 binary is present at `/opt/homebrew/opt/openssl@3/bin/openssl`; the PATH default is LibreSSL.

For an alternative CLI calibration and a subsequent two-process experiment:

1. Start an owned `s_server` with TLS 1.3, `-accept 127.0.0.1:<ephemeral-port>`, `-early_data`, `-max_early_data`, and explicit `-anti_replay`.
2. Establish an initial session and retain its session ticket locally with `s_client -sess_out`. Wait for the post-handshake ticket rather than closing before it arrives.
3. Replay an identical owned early-data payload using that original session with `-sess_in` and `-early_data <payload-file>`; record both the handshake outcome and whether application bytes were accepted as early data.
4. Compare default replay protection with an explicitly labeled intentionally weakened `-no_anti_replay` control. A successfully completed full handshake does not mean the early data was accepted.
5. Then build a two-process server using shared ticket keys and explicit external cache callbacks to test the real distributed assumption. Separate default `s_server` processes have independent ticket secrets; rejected resumption across them is not evidence of cluster-wide anti-replay.

OpenSSL documents replay protection as on by default, rejecting reused-ticket early data while forcing a full handshake. Its `s_server -early_data` option cannot be combined with the built-in HTTP modes, so transport and application effects need separate instrumentation. The included C harness establishes the single-server baseline. Extending it with explicit shared ticket keys and a real shared consume store is the next step for testing distributed behavior.

Primary references:

- [Tamarin rule and linear/persistent fact semantics](https://tamarin-prover.com/manual/master/book/005_protocol-specification-rules.html)
- [Tamarin trace properties](https://tamarin-prover.com/manual/master/book/007_property-specification.html)
- [OpenSSL s_server early-data and anti-replay options](https://docs.openssl.org/3.0/man1/openssl-s_server/)
- [OpenSSL s_client session and early-data options](https://docs.openssl.org/3.0/man1/openssl-s_client/)
- [OpenSSL early-data API and replay caveats](https://docs.openssl.org/master/man3/SSL_read_early_data/)
