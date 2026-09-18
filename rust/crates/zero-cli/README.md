# Native application adapter

`0sec-native` is the experimental session/execution CLI. It does not implement
the legacy security commands or silently invoke the TypeScript CLI.

```sh
0sec-native --help
0sec-native schema
0sec-native snapshot pin /path/to/source
0sec-native --state /tmp/zero-native.db session create --generation builtin --budget-limit 1000
0sec-native --state /tmp/zero-native.db session list
0sec-native --state /tmp/zero-native.db session show SESSION_ID
0sec-native --state /tmp/zero-native.db session budget SESSION_ID
0sec-native --state /tmp/zero-native.db session events SESSION_ID --after 0 --limit 100
0sec-native --state /tmp/zero-native.db exec --session SESSION_ID --command-id COMMAND_ID --request request.json
0sec-native --state /tmp/zero-native.db app-server
```

The default state path is `.0sec/native/state.db`, relative to the working
directory. It is separate from the legacy database. `--docker-bin` explicitly
selects the Docker executable; requests cannot override that host setting.
Execution JSON must satisfy the generated protocol schema, including its pinned
source snapshot. The executor resolves a local image; this command does not pull
images or provision Docker.

`snapshot pin` prints a `SnapshotPin` for the execution request's `snapshot`
field and does not create a database. It records current file identities;
execution rejects subsequently changed source. Write the manifest outside the
source directory so the manifest itself does not change the indexed tree.
`session budget` reads persisted integer microcurrency units for inference reservations and charges.

App-server uses one JSON request per line and reserves stdout for JSON responses
and execution events. Initialize each connection first:

```json
{"protocol_version":1,"id":"hello","command":{"method":"initialize"}}
{"protocol_version":1,"id":"sessions","command":{"method":"session_list"}}
```

Responses echo the request `id`; operation `command_id` supplies persistent
deduplication independently of transport correlation. Executions and inference run concurrently
so cancellation requests can be accepted while work is active. There are at most
64 outstanding execution or inference responses per connection. Initialization, session
commands and cancellation are handled in input order. Execution completion order
is not request order. Malformed or oversized records yield errors and the next
record remains usable. EOF, SIGINT and SIGTERM initiate engine shutdown and
drain execution cleanup before exit.

One-shot commands print a final JSON reply. Engine errors and non-successful
execution outcomes use nonzero exit status. Schema/help/version do not open the
database. Tests launch the built executable and cover this wire behavior and
cross-process session persistence without provider requests.

## Explicit provider inference

Supply a profile file using `--providers providers.json`. All fields are required;
there are no default models, prices or credentials. Rate values are integer
microcurrency units per million tokens. Limits apply to the entire response.

```json
{"work":{"url":"https://api.openai.com/v1/responses","api_key_env":"OPENAI_API_KEY","rates":{"input":1000000,"cached_input":500000,"output":2000000},"timeout_ms":60000,"max_response_bytes":8388608}}
```

Those rates are illustrative, not current provider pricing. Set the named secret
in the process environment. Configuration and request files are bounded to the
protocol frame limit. Credentials remain in memory and are never persisted as
part of requests. Schema/help/version skip provider files and credential access.

```json
{"model":"YOUR_MODEL","instructions":"Answer briefly","input":[{"role":"user","content":"Hello"}],"tools":[],"max_output_tokens":128}
```

```sh
0sec-native --providers providers.json infer --session SESSION_ID --command-id UNIQUE_ID --provider work --reservation 100 --request inference.json
0sec-native --providers providers.json app-server
```

Reservation and session budget use the same integer units. Reusing the same
command ID with the same request returns the persisted outcome without another
provider call. Changed payloads conflict. Incomplete or failed outcomes exit
nonzero; unknown usage does not become a zero charge. The app-server `infer`
method uses the same fields; `cancel.execution_id` is the inference command ID.
No OAuth or implicit provider routing is implemented.
