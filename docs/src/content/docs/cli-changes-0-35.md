---
title: CLI changes in 0.35
description: The CLI is now nine commands. Every old command and flag still works for one release; this page maps each old command to its replacement.
---

0.35 reduces the CLI to nine top-level commands, each with at most three subcommands in `--help`:

```text
0                         open the web console
0 scan <target>           scan a URL, a folder, or npm:/pypi:/cargo:/oci: packages
0 scan fix | verify | disclose
0 findings                list | show | update
0 threads                 list | send | stop
0 agents                  list | run | set
0 skills                  list | add | run
0 memory                  list | set | export
0 models                  list | set | connect
0 computers               list | add | stop
0 config                  get | set | doctor
```

## What keeps working

Nothing you have scripted stops working in this release. Every old command, subcommand and flag is still registered, hidden from `--help`, and runs the same code with the same arguments and exit codes. On a terminal an old invocation also prints one dim line to stderr:

```text
moved: use `0 findings update <id> --status accepted`
```

The line is not printed when stdout is not a terminal (pipes, CI) or when `--json` is given. The old names are removed in the release after 0.35.

- `0 web` is now `0`. The web flags (`--port`, `--host`, `--headless`, `--no-open`, `--ready-json`, `--server-mode`, `--db-path` and the rest) work on `0` directly, for example `0 --headless --ready-json`. `0 web ...` keeps working and prints the moved line.
- `0 doctor` stays as a permanent alias of `0 config doctor` and prints no notice. `doctor upgrade`, `doctor workbench` and `doctor checks` are reached as `0 config doctor upgrade|workbench|checks`.
- `0 api` and `0 lab` are hidden developer commands and are unchanged. `0 -p`, `0 -c` and `0 -r` are unchanged.
- The hidden flags `--mode`, `--yolo`, `--autonomy` and `--tool-access` keep working as documented aliases of `--access` and the approvals setting.

## Choices the new grammar makes

Where the earlier commands do not fold into a single verb, the new form is a flag on the verb you already know. These are the same flag everywhere:

- `0 scan <target> --module deep|repair|campaign|deps|deps-fix` runs the module that has no target-detecting form. Targets are still detected for URLs, folders and packages.
- `0 agents list|run|set ... --automation` works on saved automations, with the arguments `automation` always had. `0 agents set --create`, `--state active|paused|acknowledged|archived|deleted`, `--budget`, `--trigger <sub>` and `--files <sub>` replace the old `agents` verbs.
- `0 threads list <id>` shows one thread; add `--events`, `--export`, `--rename <title>`, `--set`, `--clear`, `--close`, `--archive` or `--delete` to act on it. `0 threads send new <prompt>` starts a thread; `0 threads send <id> --retry|--resume|--decide <decision-id>` replaces the old verbs.
- `0 skills add <source>` takes a catalog id, a repository, a folder or a bundle. `--plugin` or `--local` installs a plugin, `--new <name>`, `--validate` and `--submit` author one, `--mcp <url>` adds an MCP server and `--connect <service>` connects a service. `0 skills list <name> --info|--enable|--disable` acts on a plugin.
- `0 config get|set` take the namespaces `audit`, `team`, `db`, `github` and `api.key`; `--all`, `--export`, `--from-file` and `--reset` replace `list`, `export`, `import` and `reset`.
- `automation versions` and `automation rollback` are removed after this release; use git history for versions.
- `scan eval` and `scan agent-assure` move into plugins after this release. `lab research` and `lab improve` stay hidden until their destinations exist (the private package and the benchmark plugin); they are not removed in 0.35.

## Every old command

### scan

| Old | New |
| --- | --- |
| `0 scan web` | `0 scan <target>` |
| `0 scan source` | `0 scan <target>` |
| `0 scan package` | `0 scan <target>` |
| `0 scan deep` | `0 scan <target> --module deep` |
| `0 scan repair` | `0 scan <target> --module repair` |
| `0 scan campaign` | `0 scan <target> --module campaign` |
| `0 scan deps scan` | `0 scan <dir> --module deps` |
| `0 scan deps fix` | `0 scan <dir> --module deps-fix` |
| `0 scan deps` | `0 scan <dir> --module deps` |
| `0 scan eval` | the benchmark plugin (removed after 0.35) |
| `0 scan agent-assure` | the agent-assure plugin (removed after 0.35) |
| `0 scan disclose evidence-pack` | `0 scan disclose --pack <finding.json>` |
| `0 scan disclose track` | `0 scan disclose --track <id>` |
| `0 scan disclose review` | `0 scan disclose --review <finding.json>` |

### findings

| Old | New |
| --- | --- |
| `0 findings accept` | `0 findings update <id> --status accepted` |
| `0 findings suppress` | `0 findings update <id> --status suppressed` |
| `0 findings reopen` | `0 findings update <id> --status open` |
| `0 findings triage mark-fp` | `0 findings update <id> --status false-positive` |
| `0 findings triage memory add` | `0 memory set --add` |
| `0 findings triage memory list` | `0 memory list --triage` |
| `0 findings triage memory remove` | `0 memory set --remove <id>` |
| `0 findings triage memory` | `0 memory list --triage` |
| `0 findings triage` | `0 findings update <id> --status ...` |
| `0 findings export` | `0 findings list --format sarif\|json\|md` |
| `0 findings reports import` | `0 findings list --import <report>` |
| `0 findings reports export` | `0 findings list --format md` |
| `0 findings reports` | `0 findings list` |
| `0 findings keys list` | `0 config get api.keys` |
| `0 findings keys create` | `0 config set api.key <name>` |
| `0 findings keys revoke` | `0 config set api.key --revoke <id>` |
| `0 findings keys` | `0 config get api.keys` |

### threads

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

### agents

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
| `0 agents budget` | `0 agents set <id> --budget` |
| `0 agents activations` | `0 agents run <id> --history` |
| `0 agents files` | `0 agents set <id> --files list\|get\|put\|rm` |
| `0 agents triggers` | `0 agents set <id> --trigger list\|add\|enable\|disable\|check\|rm` |

### automation (now `agents --automation`)

| Old | New |
| --- | --- |
| `0 automation list` | `0 agents list --automation` |
| `0 automation show` | `0 agents list <id> --automation` |
| `0 automation run` | `0 agents run <id> --automation` |
| `0 automation create` | `0 agents set --automation create` |
| `0 automation edit` | `0 agents set --automation edit <id>` |
| `0 automation duplicate` | `0 agents set --automation duplicate <id>` |
| `0 automation delete` | `0 agents set --automation delete <id>` |
| `0 automation triggers` | `0 agents set --automation triggers <list\|enable\|disable\|remove>` |
| `0 automation versions` | git history (this command is removed after 0.35) |
| `0 automation rollback` | git (this command is removed after 0.35) |
| `0 automation` | `0 agents list --automation` |

### models

| Old | New |
| --- | --- |
| `0 models default` | `0 models set <model>` |
| `0 models recommended` | `0 models list --recommended` |
| `0 models connections` | `0 models connect <provider>` |
| `0 models usage` | `0 models list --usage` |

### computers

| Old | New |
| --- | --- |
| `0 computers deploy` | `0 computers add` |
| `0 computers repair` | `0 config doctor` |
| `0 computers hosts` | `0 computers list --hosts` |

### skills

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

### plugin (now `skills`)

| Old | New |
| --- | --- |
| `0 plugin list` | `0 skills list` |
| `0 plugin search` | `0 skills list` |
| `0 plugin browse` | `0 skills list --catalog` |
| `0 plugin info` | `0 skills list <id> --info` |
| `0 plugin enable` | `0 skills list <id> --enable` |
| `0 plugin disable` | `0 skills list <id> --disable` |
| `0 plugin install` | `0 skills add <id> --plugin` |
| `0 plugin run` | `0 skills run <name>` |
| `0 plugin init` | `0 skills add --new <name>` |
| `0 plugin validate` | `0 skills add <dir> --validate` |
| `0 plugin submit` | `0 skills add <dir> --submit` |
| `0 plugin connectors` | `0 skills list --connectors` |
| `0 plugin connect` | `0 skills add --connect <service>` |
| `0 plugin disconnect` | `0 skills add --disconnect <service>` |
| `0 plugin mcp add` | `0 skills add --mcp <url>` |
| `0 plugin mcp list` | `0 skills list --mcp` |
| `0 plugin mcp test` | `0 skills list <id> --mcp-test` |
| `0 plugin mcp remove` | `0 skills list <id> --mcp-remove` |
| `0 plugin mcp` | `0 skills add --mcp <url>` |
| `0 plugin` | `0 skills` |

### memory

| Old | New |
| --- | --- |
| `0 memory enable` | `0 memory set <id> on` |
| `0 memory disable` | `0 memory set <id> off` |
| `0 memory import` | `0 memory set --import <file>` |

### config

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

### doctor

| Old | New |
| --- | --- |
| `0 doctor upgrade` | `0 config doctor upgrade` |
| `0 doctor workbench` | `0 config doctor workbench` |
| `0 doctor checks` | `0 config doctor checks` |

### web

| Old | New |
| --- | --- |
| `0 web` | `0` |


Commands that moved in earlier releases (`hunt`, `review`, `audit`, `secure`, `triage`, `history`, `resume` and the rest) keep their previous aliases and now say where their implementation lives, for example `0 hunt` prints `moved: use 0 lab research hunt`.
