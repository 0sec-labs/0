---
title: Extensions
description: Connect 0 to your tools and services with reviewed, commit-pinned extensions.
---

Extensions connect 0 to your tools and services: GitHub, MCP servers and rules. Each is pinned to a commit and never updates on its own. An extension is a git folder pinned to one commit. It can give 0 a [connection](#connect-a-service) to a service, start MCP servers, or add rules such as a verifier. There is no second runtime: its MCP servers and any scripts are ordinary commands under the same approvals and sandbox as anything the agent runs. Themes are not extensions. Read the [security model](/configuration/#security-model) before adding third-party code.

An extension may also come with a [skill](/skills/) that explains how to use it; that skill appears on the Skills page labelled with its source.

> **Skills vs Extensions**
> - Skills are instructions the model loads. They contain no code.
> - Extensions are connections, tools and rules.
> - An extension can bring a skill along.
> - Skills never connect to anything on their own.

## Add one

```sh
0 skills add owner/repo@<full 40-character commit>
0 skills extensions add ./my-extension
0 skills extensions mcp docs --url https://example.com/mcp
0 skills extensions mcp docs -- npx some-mcp-server@1.2.3
```

You always see one prompt first: the repository at the full commit, the licence, the files, hidden-Unicode flags and what it can do (which service it connects to, MCP servers it starts, rules it adds, and any skills it adds last). Nothing is installed without `--yes` from your own terminal, and a flag alone never approves. Without a pinned commit, `--yes` is refused. The browser app has the same flow on **Extensions**: **Add extension** takes a git source, **Add MCP server** takes a command or an https URL and creates a local extension that goes through the same prompt.

## Manage them

```sh
0 skills extensions list
0 skills extensions info <name>
0 skills extensions enable <name>
0 skills extensions disable <name>
0 skills extensions update <name>
0 skills extensions remove <name> --yes
```

An extension is installed disabled; enabling asks you to approve the exact revision once. `update` shows the folder diff and what it can now do, and asks again: any change re-prompts, even one new script, and nothing updates on its own. Built-in extensions (such as `github`) update with the 0 binary.

`0 skills extensions info` also shows each MCP server's tools with the approved and last-seen hash. See [MCP servers](#mcp-servers).

## Repo files are suggestions

A repository's `.0/` or `.claude/` folder (settings, `.mcp.json`, skills) never installs or enables an extension or MCP server. On first open the app shows what the repo asks for, with the install prompt for each; ignored means nothing runs. A plain `SKILL.md` is still read as instructions.

## MCP servers

In the browser app, open **Extensions** and press **Add**, then **MCP server**. Type the command that starts it or an https URL. It becomes a local extension that goes through the same review as any other: nothing runs until you read the exact command and approve it, and it is saved turned off. Once enabled, it starts only when a thread first uses it, and its tools are pinned. From the command line:

```sh
0 skills extensions mcp docs --url https://example.com/mcp
0 skills extensions mcp docs -- npx some-mcp-server@1.2.3        # shows the review; add --yes to approve it
0 skills extensions info docs
0 skills extensions enable docs
0 skills extensions remove docs --yes
```

Secrets are not typed on the command line: an extension declares the variable names it needs and the review lists them. Every command takes `--json`. The browser app and headless threads also read a JSON array in `ZERO_MCP`: local entries take `id`, `command` and optional `args`, `env` and `cwd`; remote entries take `id`, `url` and optional `headers`. Tools appear as `mcp__<server-id>__<tool-name>`, results are untrusted, and starting a stdio server runs its code as you, so give it only the credentials and files it needs. Malformed entries and failed connections are skipped.

### Servers bundled in an extension

An extension can bundle MCP servers, so installing one is a single, reviewed step. Declare them in `extension.json` under `"0": { "mcp": { ... } }`, or ship a Claude-style `.mcp.json`. The shape is the same as `.mcp.json`: a `command` and `args` for a local server, or a `url` (with `"type": "http"` or `"sse"`) for a remote one, plus the names of environment variables the server needs under `env` and an optional one-line `description`. Values are never stored in the extension. The install prompt lists every server, command, argument, URL and variable name, and changing any of them asks again.

- **Commands and network.** Starting a local server is a `process` command and connecting to a URL is a `network` command, so both go through `beforeCommand` with your "Ask before running commands" setting. A deny keeps the server from starting. Local servers run in the extension's folder with only the variable names they declared (plus a small base set); model provider keys are not passed unless declared and approved.
- **Pinned tools.** The first time a server connects, 0 asks you to approve its tools. It records a sha256 of each tool's name, description, input schema and annotations. On every later connection the hashes are compared. If any tool is changed, new or removed, the whole server is blocked, nothing from it is advertised or callable, and the thread shows one line such as `changed: echo; blocked until you approve them again`. Approve again in the thread when asked, or review it on the Extensions page, which shows Changed, New and Removed. With nobody to ask (no approval channel), it stays blocked.
- **Pinned packages.** A server started with `npx`, `bunx`, `pnpm dlx`, `npm exec`, `uvx`, `uv tool run`, `pipx run` or `pip install` downloads code every time it starts, so the arguments must pin an exact version: `pkg@1.2.3`, `pkg==1.2.3` or a full git commit. Otherwise it is refused with a message that says what to change. The install prompt lists what will be fetched and from where.
- **Remote servers.** HTTPS only (plain `http` only to `localhost`, `127.0.0.1` or `[::1]`). The host name is resolved, and a name that points to a private, loopback, link-local or cloud-metadata address is refused, before connecting and before each request. Redirects are refused. 0 declares no sampling, elicitation or roots capability, so a server cannot ask the model or you for anything.
- **Secrets.** A server receives a connector's stored token only for a variable name that its extension declared and you approved (the connector's `env`), filled from the connection store, never from the model's environment. The value is masked if the server echoes it back. Commands that change approvals or connections refuse to run from inside a server, or from any thread.

`0 skills extensions info <name>` lists the extension's servers and, for each tool, the approved hash and the hash last seen.


## Connect a service

A connection links 0 to a service such as GitHub. Connections belong to extensions: GitHub ships built in, and other services come as connector extensions you install.

### Connect GitHub

1. Run `0` and open **Extensions**. GitHub is the first row.
2. Press **Connect** and pick one way:
   - **Sign in with GitHub** shows a one-time code to enter at github.com/login/device.
   - **Use a token** links to GitHub's token page with the permissions pull requests need, then you paste the token.

GitHub is built in. It cannot be removed, because pull request Sentinels use it, and it updates with the `0` binary. Turning it off pauses pull request Sentinels and asks you to confirm.

GitHub stores the credential in `gh`'s own store. 0 never reads it and no script ever receives it. The card lists what the connection may do: read pull requests, pull request diffs, repository contents and the repository list, and write comments on pull requests.

### Connect another service

Install the connector extension (`0 skills add <source>` or **Add** in the browser app). The install prompt shows the connector's declared read and write list, the hosts it may reach and the variable its token fills. After you approve it, its card appears on **Extensions** with one **Connect** button. Paste the token, 0 checks it against the connector's declared health URL when it has one, and stores it on this computer in `~/.0/extensions/connections.json` (readable only by you).

A script in the extension receives the token only when the extension declared that variable name and you approved the prompt. When the bash tool runs a command that names a file inside an enabled extension's folder, the declared and approved variables (the stored token included) are added to the command's environment, and the value is masked in the output. An extension whose approval does not cover a variable it declares does not run. MCP servers of the extension get the token the same way. Model provider keys and every other secret stay out. **Disconnect** deletes the stored token.

### Connector reference

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

A `scripts/notify.sh` in the same folder reads `$CHAT_NOTIFY_TOKEN`. Scripts run through bash under the usual approvals and sandbox.
