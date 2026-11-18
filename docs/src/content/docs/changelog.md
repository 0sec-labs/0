---
title: Changelog
description: Where release notes live, and the migration notes for the 0.35 CLI and 0.36 extension changes.
---

The full history is in [`docs/CHANGELOG.md`](https://github.com/0sec-labs/0security/blob/main/docs/CHANGELOG.md), with a summary per release from v0.11.0 on. Each release also has notes on the [GitHub Releases](https://github.com/0sec-labs/0security/releases) page. This page keeps the two migration notes that people still need.

## Moving to extensions (0.36)

Version 0.36 replaced the old plugin system with [extensions](/extensions/): one installable, commit-pinned unit for skills, scripts, MCP servers, connectors and scope policies. The first start imports your old data without changing or deleting it, and `0 skills extensions import` prints the report again. Installed GitHub plugins and model-written plugins appear as disabled entries marked "could not migrate" (re-express them as scripts or MCP servers), custom MCP servers become local extensions that need approval, and token-only service connections become connector extensions that need approval and a new token.

## CLI changes in 0.35


0.35 reduced the CLI to nine top-level commands; the scan command has since been removed, leaving eight, each with at most three subcommands in `--help`:

```text
0                         open the web console
0 findings                list | show | update
0 threads                 list | send | stop
0 agents                  list | run | set
0 skills                  list | add | run
0 memory                  list | add | remove
0 models                  list | set | connect
0 computers               list | add | stop
0 config                  get | set | doctor
```

### What keeps working

Nothing you have scripted stops working in this release. Every old command, subcommand and flag is still registered, hidden from `--help`, and runs the same code with the same arguments and exit codes. On a terminal an old invocation also prints one dim line to stderr:

```text
moved: use `0 findings update <id> --status accepted`
```

The line is not printed when stdout is not a terminal (pipes, CI) or when `--json` is given. The old names are removed in the release after 0.35.

- `0 web` is now `0`. The web flags (`--port`, `--host`, `--headless`, `--no-open`, `--ready-json`, `--server-mode`, `--db-path` and the rest) work on `0` directly, for example `0 --headless --ready-json`. `0 web ...` keeps working and prints the moved line.
- `0 doctor` stays as a permanent alias of `0 config doctor` and prints no notice. `doctor upgrade`, `doctor workbench` and `doctor checks` are reached as `0 config doctor upgrade|workbench|checks`.
- `0 api` and `0 lab` are hidden developer commands and are unchanged. `0 -p`, `0 -c` and `0 -r` are unchanged.
- The flags `--access`, `--mode`, `--autonomy` and `--tool-access` are removed from help. There is one mode, so they are accepted and ignored for one release (on a terminal, one dim line says so).

### Choices the new grammar makes

Where the earlier commands do not fold into a single verb, the new form is a flag on the verb you already know. These are the same flag everywhere:

- `0 threads list <id>` shows one thread; add `--events`, `--export`, `--rename <title>`, `--set`, `--clear`, `--close`, `--archive` or `--delete` to act on it. `0 threads send new <prompt>` starts a thread; `0 threads send <id> --retry|--resume|--decide <decision-id>` replaces the old verbs.
- `0 skills add <source>` takes a catalog id, a repository, a folder or a bundle. `--mcp <url>` adds an MCP server as a local extension. Extensions are installed with `0 skills add <repo>@<sha>` and managed with `0 skills extensions`; the plugin flags (`--plugin`, `--local`, `--new`, `--validate`, `--submit`, `--connect`) were folded into those or removed, see the plugin table below.
- `0 config get|set` take the namespaces `audit`, `team`, `db`, `github` and `api.key`; `--all`, `--export`, `--from-file` and `--reset` replace `list`, `export`, `import` and `reset`.

### Every old command

#### findings

| Old | New |
| --- | --- |
| `0 findings accept` | `0 findings update <id> --status accepted` |
| `0 findings suppress` | `0 findings update <id> --status suppressed` |
| `0 findings reopen` | `0 findings update <id> --status open` |
| `0 findings triage mark-fp` | `0 findings update <id> --status false-positive` |
| `0 findings triage memory add` | `0 memory add <text> --kind avoid` |
| `0 findings triage memory list` | `0 memory list` |
| `0 findings triage memory remove` | `0 memory remove <id>` |
| `0 findings triage memory` | `0 memory list` |
| `0 findings triage` | `0 findings update <id> --status ...` |
| `0 findings export` | `0 findings list --format sarif\|json\|md` |
| `0 findings reports import` | `0 findings list --import <report>` |
| `0 findings reports export` | `0 findings list --format md` |
| `0 findings reports` | `0 findings list` |
| `0 findings keys list` | `0 config get api.keys` |
| `0 findings keys create` | `0 config set api.key <name>` |
| `0 findings keys revoke` | `0 config set api.key --revoke <id>` |
| `0 findings keys` | `0 config get api.keys` |

#### threads

| Old | New |
| --- | --- |
| `0 threads show` | `0 threads list <id>` |
| `0 threads create` | `0 threads send new <prompt>` |
| `0 threads start` | `0 threads send new <prompt>` |
| `0 threads continue` | `0 threads send <id> [text]` |
| `0 threads resume` | `0 threads send <id> --resume` |
| `0 threads retry` | `0 threads send <id> --retry` |
| `0 threads decide` | `0 threads send <id> --decide <decision-id>` |
| `0 threads cancel` | `0 threads stop <id>` |
| `0 threads force-stop` | `0 threads stop <id> --force` |
| `0 threads events` | `0 threads list <id> --events` |
| `0 threads export` | `0 threads list <id> --export` |
| `0 threads set` | `0 threads list <id> --set ...` |
| `0 threads rename` | `0 threads list <id> --rename <title>` |
| `0 threads clear` | `0 threads list <id> --clear` |
| `0 threads close` | `0 threads list <id> --close` |
| `0 threads archive` | `0 threads list <id> --archive` |
| `0 threads delete` | `0 threads list <id> --delete` |

#### agents

| Old | New |
| --- | --- |
| `0 agents show` | `0 agents list <id>` |
| `0 agents presets` | `0 agents list --presets` |
| `0 agents create` | `0 agents set --create` |
| `0 agents pause` | `0 agents set <id> --state paused` |
| `0 agents resume` | `0 agents set <id> --state active` |
| `0 agents acknowledge` | `0 agents set <id> --state acknowledged` |
| `0 agents archive` | `0 agents set <id> --state archived` |
| `0 agents delete` | `0 agents set <id> --state deleted` |
| `0 agents activations` | `0 agents run <id> --history` |
| `0 agents files` | `0 agents set <id> --files list\|get\|put\|rm` |
| `0 agents triggers` | `0 agents set <id> --trigger list\|add\|enable\|disable\|check\|rm` |

#### models

| Old | New |
| --- | --- |
| `0 models default` | `0 models set <model>` |
| `0 models recommended` | `0 models list --recommended` |
| `0 models connections` | `0 models connect <provider>` |
| `0 models usage` | `0 models list --usage` |

#### computers

| Old | New |
| --- | --- |
| `0 computers deploy` | `0 computers add` |
| `0 computers repair` | `0 config doctor` |
| `0 computers hosts` | `0 computers list --hosts` |

#### skills

| Old | New |
| --- | --- |
| `0 skills show` | `0 skills list <name>` |
| `0 skills catalog` | `0 skills list --catalog` |
| `0 skills new` | `0 skills add <file>` |
| `0 skills edit` | `0 skills list <name> --edit` |
| `0 skills copy` | `0 skills list <name> --copy` |
| `0 skills import` | `0 skills add <bundle>` |
| `0 skills export` | `0 skills list <name> --export` |
| `0 skills link` | `0 skills add <dir>` |
| `0 skills unlink` | `0 skills list <name> --unlink` |
| `0 skills delete` | `0 skills list <name> --delete` |
| `0 skills remove` | `0 skills add --remove <name>` |

#### plugin (now `skills extensions`)

The `plugin` group is hidden and kept as aliases. The executable plugin runtime, the registry and `self_extend` were removed; see the changelog.

| Old | New |
| --- | --- |
| `0 plugin list` | `0 skills extensions list` |
| `0 plugin search` | `0 skills extensions list` |
| `0 plugin browse` | `0 skills list --catalog` |
| `0 plugin info` | `0 skills extensions info <name>` |
| `0 plugin enable` | `0 skills extensions enable <name>` |
| `0 plugin disable` | `0 skills extensions disable <name>` |
| `0 plugin install` | `0 skills add <repo>@<sha>` |
| `0 plugin run` | the extension's scripts, run through bash |
| `0 plugin init` | the folder flow: extension.json or SKILL.md, then 0 skills add <folder> --preview |
| `0 plugin validate` | `0 skills add <folder> --preview` |
| `0 plugin submit` | the extension flow: 0 skills add <repo>@<sha> (registry submission was removed) |
| `0 plugin connectors` | `0 skills extensions list` |
| `0 plugin connect` | the Extensions page in the web app |
| `0 plugin disconnect` | the Extensions page in the web app |
| `0 plugin mcp add` | `0 skills extensions mcp <name> --url <url>` |
| `0 plugin mcp list` | `0 skills extensions list` |
| `0 plugin mcp test` | `0 skills extensions info <name>` |
| `0 plugin mcp remove` | `0 skills extensions remove <name>` |
| `0 plugin mcp` | `0 skills extensions mcp <name> --url <url>` |
| `0 plugin` | `0 skills extensions` |

#### memory

| Old | New |
| --- | --- |
| `0 memory enable` | still `0 memory enable` (it now turns Memory on or off for all notes) |
| `0 memory disable` | still `0 memory disable` (it now turns Memory on or off for all notes) |
| `0 memory import` | still `0 memory import <file>` |

#### config

| Old | New |
| --- | --- |
| `0 config show` | `0 config get` |
| `0 config list` | `0 config get --all` |
| `0 config reset` | `0 config set --reset` |
| `0 config export` | `0 config get --export` |
| `0 config import` | `0 config set --from-file <file>` |
| `0 config audit-log` | `0 config get audit` |
| `0 config team list` | `0 config get team` |
| `0 config team` | `0 config set team <init\|add-user>` |
| `0 config db repair` | `0 config doctor --fix` |
| `0 config db` | `0 config set db reset` |
| `0 config github status` | `0 config get github` |
| `0 config github` | `0 config set github <connect\|repos>` |

#### doctor

| Old | New |
| --- | --- |
| `0 doctor upgrade` | `0 config doctor upgrade` |
| `0 doctor workbench` | `0 config doctor workbench` |

#### web

| Old | New |
| --- | --- |
| `0 web` | `0` |


Commands that moved in earlier releases (`hunt`, `review`, `audit`, `secure`, `triage`, `history`, `resume` and the rest) belonged to the scan and research engines, which were removed (see the Unreleased notes in the full changelog).
