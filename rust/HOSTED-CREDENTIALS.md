# Native hosted credential lifecycle

`0sec-native hosted` also accepts the `auth` alias. Browser login continues to
print the sign-in URL and waits for its scoped browser session before saving.
Manual import reads a named environment variable without sending a request:

```sh
0sec-native auth --host https://cloud.0.security login --token-from-env MY_CLOUD_TOKEN
0sec-native auth status
0sec-native auth logout
```

Set `MY_CLOUD_TOKEN` using your existing secret-management mechanism. The command
accepts the environment variable's name, not the token as a command argument.
Import validates token format and the hosted transport configuration; its
`credential_validation: format_only` result does not prove the server accepts
the credential. `status` is the existing hosted health check, not an account or
permission audit. `account` and `usage` retain their existing read-only APIs.

Browser login and manual import write `HOME/.0sec/cloud.env` atomically with
mode0600 under an owned mode0700 directory. `--credentials /absolute/file` selects
an existing private directory instead. Tokens are never included in command
output or diagnostics. Native login does not currently write the legacy secondary
`HOME/.0cloud/credentials.json` credential bridge. Both login paths report when
`0SEC_CLOUD_TOKEN` remains active ahead of the saved file.

Logout removes both `HOME/.0sec/cloud.env` and
`HOME/.0cloud/credentials.json`. `logout --credentials /absolute/file` removes
only that selected file. Missing files/directories are an idempotent success.
It opens no Engine state, reads no token contents and makes no remote request.
Environment tokens remain active, and remote sessions/tokens are not revoked.
The report explicitly distinguishes saved-file removal from remote revocation.

Unix filesystem support is currently required. Paths must be absolute with
normal components and no symlinks. Logout checks every candidate before removing
any file, rejects linked/nonregular files and directories writable by others,
and syncs each parent after removal. Native login/logout coordinate through
nonblocking directory locks. Other programs do not necessarily honor these
locks: this is not an isolation boundary against another process with the same
filesystem access. Removal of two stores is not atomic; interruption or an I/O
failure can leave a partial removal, reported as an error. Retry handles already
removed files. A signal during filesystem work joins that work before exit.

Tests use disposable homes, a loopback listener and fixture tokens. They exercise
private offline import, malformed-input preservation, missing-file retries,
symlink/hardlink rejection before removal, explicit-file scoping, environment
precedence and exclusion between login/logout. Existing browser approval,
timeout, cancellation and secret-output regressions remain required.
