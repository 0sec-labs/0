---
title: Connect a service
description: Connect GitHub or another service once, see what it can read and write, and keep the secret out of scripts.
---

A connection links 0 to a service such as GitHub. Connections belong to [extensions](/skills/#extensions): GitHub ships built in, and other services come as connector extensions you install.

## Connect GitHub

1. Run `0` and open **Extensions**. The GitHub card is at the top.
2. Press **Connect** and pick one way:
   - **GitHub CLI login** uses the `gh` login already on this computer.
   - **Sign in with GitHub** shows a one-time code to enter at github.com/login/device.
   - **Fine-grained token** opens GitHub's token page with the permissions pull requests need, then you paste the token.

GitHub is built in. It cannot be removed, because pull request Agents, the pull request trigger and the webhook receiver use it, and it updates with the `0` binary. Turning it off pauses pull request Agents and asks you to confirm.

GitHub stores the credential in `gh`'s own store. 0 never reads it and no script ever receives it. The card lists what the connection may do: read pull requests, pull request diffs, repository contents and the repository list, and write comments on pull requests.

## Connect another service

Install the connector extension (`0 skills add <source>` or **Add extension**). The install prompt shows the connector's declared read and write list, the hosts it may reach and the variable its token fills. After you approve it, its card appears on **Extensions** with one **Connect** button. Paste the token, 0 checks it against the connector's declared health URL when it has one, and stores it on this computer in `~/.0/extensions/connections.json` (readable only by you).

A script in the extension receives the token only when the extension declared that variable name and you approved the prompt. Model provider keys and every other secret stay out. **Disconnect** deletes the stored token.

If you used service plugins before, token-only connections (such as Slack or Linear) are imported once as connector extensions that need approval. The old token is not copied: connect again to fill the new slot. Services that need a URL or identifiers as well (such as Jira or Elastic) are listed in the import report and keep working where they are.

## Connector reference

The `connector` block of an extension manifest (`extension.json`, or the `"0"` object of `plugin.json`):

| Field | Meaning |
| --- | --- |
| `service` | Short id, lower case (`github`, `chat`). |
| `title`, `description`, `category` | Shown on the card. `title` defaults to `service`. |
| `auth` | The default way to connect: `token`, `oauth-device` (one-time code), `cli-login` (a program already signed in, such as `gh`) or `none`. `cli` is accepted as an older spelling of `cli-login`. |
| `methods` | Every way to connect, first is preselected. Defaults to `[auth]` and must include `auth`. |
| `env` | Variable names the connection fills for the extension's scripts, for example `["CHAT_TOKEN"]`. A `token` connector must declare one. The name must be an allowed credential name (upper case, ending `_TOKEN`, `_KEY`, ...); loader variables are never allowed. |
| `hosts` | Hosts it may reach. A health URL must be https on one of them. |
| `access.read`, `access.write` | What it may read and write, in plain words. Shown in the install prompt and on the card; changing them asks again. |
| `health` | `{"type": "none"}` (default), `{"type": "adapter"}` (ask the sign-in adapter, as GitHub does) or `{"type": "http", "url": "https://..."}` (GET with the token as a bearer token; 401/403 means rejected). |
| `connectLabel` | Text of the Connect button. Defaults to `Connect`. |

Example:

```json
{
  "name": "chat-notify",
  "version": "1.0.0",
  "connector": {
    "service": "chat",
    "title": "Chat",
    "auth": "token",
    "env": ["CHAT_NOTIFY_TOKEN"],
    "hosts": ["chat.example.com"],
    "access": { "read": ["channels"], "write": ["messages"] },
    "health": { "type": "http", "url": "https://chat.example.com/api/auth.test" }
  }
}
```

A `scripts/notify.sh` in the same folder reads `$CHAT_NOTIFY_TOKEN`. Scripts run through bash under the usual scope, approvals and sandbox.
