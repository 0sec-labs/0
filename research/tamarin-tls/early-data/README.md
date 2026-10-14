# Actual TLS 1.3 early-data replay calibration

```sh
node research/tamarin-tls/early-data/run.mjs
```

Requirements: macOS `clang` and Homebrew OpenSSL 3 at `/opt/homebrew/opt/openssl@3`. The runner compiles the inspected local C source into a temporary directory, creates a temporary self-signed certificate, runs both configurations, checks the results, and removes all generated keys, certificates, session state and binaries. There are no external target arguments. Client sockets connect only to `127.0.0.1`; server sockets bind only to loopback on OS-assigned ephemeral ports. Both sides enforce TLS 1.3. The client explicitly trusts the generated certificate and verifies its localhost identity. Socket timeouts and parent/child alarms bound each calibration run.

This is a real OpenSSL early-data API experiment, separate from the post-handshake HTTPS application-ticket fixture in the parent directory. It sends a fixed 23-byte application payload using `SSL_write_early_data`, reads it with `SSL_read_early_data`, and records `SSL_get_early_data_status` independently on both client and server. It uses TLS records rather than HTTP.

Observed with OpenSSL 3.6.4:

| Server setting | Initial connection | Original ticket first use | Same original ticket reused |
| --- | --- | --- | --- |
| Anti-replay explicitly enabled | Full handshake; no early data | Resumed; early data accepted, 23 bytes | Full handshake fallback succeeds; early data rejected, 0 bytes |
| Anti-replay deliberately disabled | Full handshake; no early data | Resumed; early data accepted, 23 bytes | Resumed again; early data accepted again, 23 bytes |

Both configurations passed the assertions in `run.mjs`; the observed client and server events are retained in `result.json`. The initial connection waits for a server application acknowledgment, causing OpenSSL to process the post-handshake session ticket. The harness duplicates that original session for both attempts, rather than accidentally using the newly issued ticket from a successful resumption. Connections use TLS close notifications to preserve resumable sessions.

This is session-ticket/early-payload reuse by an owned client, not capture and retransmission of an identical raw TLS packet stream. It demonstrates the documented anti-replay property and its intentionally weakened control. It is a known TLS 1.3 0-RTT replay limitation, not a new vulnerability or a break of encryption, signatures or confidentiality. The rejected early-data attempt completes a new full handshake; handshake success must not be counted as early-data acceptance. No automatic application retry is performed.

Next discovery-oriented work should test a concrete implementation/configuration's shared ticket keys, external replay state, cache expiry, restart and failover assumptions, and application side-effect/idempotency boundaries. This single-server calibration does not establish cluster-wide security or mechanically prove correspondence to the symbolic/Lean models.

Primary OpenSSL references:

- [Early-data read/write APIs and replay limitations](https://docs.openssl.org/3.6/man3/SSL_read_early_data/)
- [Session resumption API](https://docs.openssl.org/3.6/man3/SSL_set_session/)
- [Session ticket count](https://docs.openssl.org/3.6/man3/SSL_CTX_set_num_tickets/)
