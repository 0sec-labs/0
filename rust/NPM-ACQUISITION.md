# Native published npm source acquisition

Acquire one explicit published version without installing or executing the package:

```sh
0sec-native source acquire \
  --npm-package @scope/package --version 1.2.3 \
  --registry https://registry.npmjs.org/ \
  --output /absolute/new-capture

0sec-native --providers /absolute/providers.json \
  --review-profiles /absolute/reviews.json \
  review /absolute/new-capture/source --profile local \
  --acquisition-receipt /absolute/new-capture/receipt.json
```

The registry defaults to `https://registry.npmjs.org/`. Versions must use the full
canonical `major.minor.patch` form, optionally with prerelease/build identifiers.
Tags, ranges, shorthand versions and Git selectors are rejected. The output must
not exist and its parent must already be a real directory, without symlink
components. This standalone acquisition opens no Engine database or model budget.

The host explicitly chooses the registry. HTTPS is required except for explicit
loopback HTTP fixtures. URLs must be canonical and contain no credentials, query
or fragment. The metadata endpoint must return the exact requested package name
and version. Its tarball URL must have the **same origin** as that registry.
Redirects, automatic retries, ambient proxies, npm configuration and ambient
credentials are not used. Private authenticated registries and cross-origin CDNs
are unsupported in this first path.

The tarball must have one canonical `sha512-...` integrity value. Its bytes are
checked before extraction; SHA-1-only metadata is rejected. The receipt retains
metadata and tarball SHA-256 digests, the SHA-512 integrity, registry/package/version,
actual tarball URL/length, the exact extracted snapshot and executable paths.
This binds captured bytes to the host's registry observation. It is **not** a
publisher signature or independent proof that a registry response was genuine.
Registry metadata is treated as untrusted input.

No `npm` command, shell, dependency resolver, install hook, package script or
package executable runs. Dependencies are not acquired. `package.json` must match
the requested identity; its scripts remain ordinary captured source. Extraction
uses a maintained tar reader with explicit checked entry copying, never an
unrestricted archive unpack operation. Harmless local PAX metadata and GNU long
paths are supported within bounded extension quotas. Links, sparse files,
devices, global PAX headers, duplicate/ancestor file collisions, Git metadata,
traversal, special permission bits and unsupported entry types are rejected.
Contradictory size/path extensions, malformed checksums, truncated archives,
concatenated gzip members and hidden tar/gzip trailing data also fail closed.

Limits are 2 MiB metadata, 32 MiB compressed tarball, 72 MiB expanded tar stream,
64 MiB extracted file data, 4,096 files, 16,384 tar headers, 16 KiB per extension
and 1 MiB cumulative extension data. Implicit directories are limited to 16,384
in total and 128 levels, with cancellation checks during creation. The default deadline is 60 seconds;
`--timeout-ms` permits 1–120,000 ms. Download and extraction share that absolute
deadline. Cancellation stops network reads and joins the bounded blocking
extraction/cleanup task. Owned private staging is removed on failure; an
unconfirmed cleanup reports its recovery path. Publication uses an anchored,
no-replace rename and directory synchronization. A post-publication sync error
can leave the published directory present and is reported as a failure; it never
authorizes overwriting that directory on retry.

`source/` contains normalized private modes (0600 files, 0700 executables), and
`receipt.json` contains canonical provenance. Native review checks the
selected source bytes and executable modes before admission and retains the
receipt in its immutable intent and full source archive. After source, registry,
receipt and configuration removal, exact review retries and retained reports
still use those captured bindings. A different receipt selector conflicts with
an existing command. Historical Git receipts and reviews retain their original
JSON representation and identities; npm receipts are a distinct strict shape.

Deterministic qualification uses local HTTP registries, raw tar/gzip adversarial
fixtures, retained Store provenance and actual CLI review with a loopback model
fixture. These tests do not contact npm or a paid provider and do not establish
package safety. The registry's [version metadata API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
is the transport contract; dependency-install parity remains separate work.
