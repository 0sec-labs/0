# Durable agent inputs

A queued input is user intent, separate from operation admission and budget
reservation. The native engine owns both; CLI, line console and app-server use
the same commands. No process starts work merely because it opens a database.

`queue_agent` records a complete agent request, a caller-selected command ID and
an optional `after_input` ID in the same session. Exact retries return the same
input; changing the request or predecessor conflicts. Two identical prompts with
different command IDs remain different inputs. A session admits at most 50
pending/running inputs, rejecting the newest excess input. Requests are bounded
to 128 KiB. Listing uses a sequence cursor, at most 100 rows and a 1 MiB page.
Continue from the last returned sequence; a short page need not be the end.

`run_queued_agent` always names one input ID. It never means “run whichever item
is next,” which would make retries ambiguous. Earlier pending/running inputs must
settle first. Resolving a predecessor requires its successful completed agent
operation; the engine substitutes that exact operation ID as `continuation_of`.
The input cannot also supply `continuation_of`. Existing provider, rates, hosted
quote, source, plugin and execution checks still apply to continuation. The first
input may explicitly continue an ordinary completed or checkpointed operation.
A failed/turn-limited/cancelled/unknown predecessor does not automatically advance
its dependent inputs. Inspect it and use the existing explicit continuation
workflow if appropriate; cancel superseded pending inputs individually.

Resolution writes a fixed request before dispatch. The generated
`queued-agent:UUID` command ID is reserved for queue dispatch. Admission rechecks
cancellation and resolved authority under the same control lock that admits the
agent operation. Cancellation before admission wins; after admission, use the
ordinary execution cancellation command. Queue cancellation is idempotent only
for undispatched inputs.

Status comes from the linked operation journal, not a second independently
settled queue worker. A crash after resolution but before operation admission
leaves pending intent. Recovery marks an admitted/running operation unknown and
retains its budget holds. Re-running that input returns its existing receipt;
it never redispatches the historical work. Terminal receipt replay does not need
a newly configured provider. Listing and opening state do not run pending work.
Pre-admission configuration or validation failure leaves the input pending;
post-admission failure is the operation's durable outcome. Reconcile unknown
usage explicitly using the existing budget command.

The line console acknowledges `queued input ID` only after durable acceptance.
A single bounded stdin reader retains partial lines while turns finish. Completed
turns drain the inputs accepted by that console in FIFO order, preserving provider
history. EOF drains those accepted inputs. SIGINT/SIGTERM stop the active work,
await cleanup and leave pending inputs for explicit resumption. Failed or unknown
turns stop automatic draining. Reopening the console does not silently execute
old pending inputs. `queue list/run/cancel` expose those inputs after restart.
Inputs still buffered in the terminal/reader but not acknowledged are not durable.

An app-server accepts enqueue/list/cancel requests while another turn runs.
Another CLI process cannot open a database already owned by that engine; use the
existing app-server connection for concurrent input. Remote IPC, mid-turn steering,
subagent messages, interrupted-turn continuation and context compaction remain
separate work. Queuing does not freeze a live provider connection or quoted price
before dispatch; explicit configured profiles govern dispatch, and predecessor
continuation checks prohibit changing an already established authority.

Schema 5 adds the input table transactionally to native schema 4 and retains the
existing journal/artifacts. Read-only exporters require the current exact schema
and never perform migrations. Open an older native database with the writable
engine before using current read-only export. This is not a legacy TypeScript DB
import or a change to production CLI/release routing.
