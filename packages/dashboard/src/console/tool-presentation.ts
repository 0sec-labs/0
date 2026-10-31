import type { ToolCallState } from "./transcript";
import { toolCallStatus } from "./tool-call-status";

export interface ToolPresentation {
  title: string;
  command?: string;
  source?: string;
  input?: string;
  output?: string;
  outputKind: "terminal" | "text" | "json";
  status: "Running" | "Done" | "Stopped" | "Error";
  language?: string;
  metadata: Array<{ label: string; value: string }>;
  rawArguments: string;
  rawResult: string;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { const decoded: unknown = JSON.parse(value); return record(decoded) || Array.isArray(decoded) ? decoded : value; } catch { return value; }
}

/** Keep original diagnostics available without printing image bytes into a text card. */
export function toolPresentationText(value: unknown): string {
  if (typeof value === "string") {
    if (/^data:image\//i.test(value)) return "(image data; see preview)";
    const decoded = parsed(value);
    return decoded === value ? value : toolPresentationText(decoded);
  }
  const seen = new WeakSet<object>();
  return JSON.stringify(value, function (key, child) {
    if (typeof child === "string" && (key === "imageBase64" || key === "data" && this?.type === "image" || /^data:image\//i.test(child))) return "(image data; see preview)";
    if (child && typeof child === "object") { if (seen.has(child)) return "(circular reference)"; seen.add(child); }
    return child;
  }, 2) ?? "";
}

/** Present observed command/source/output rather than the engine's transport wrapper. */
export function presentToolCall(call: ToolCallState): ToolPresentation {
  const args = record(parsed(call.arguments)) ? parsed(call.arguments) as Record<string, unknown> : {};
  const rawResult = toolPresentationText(call.result);
  let payload = parsed(call.result);
  const metadata: ToolPresentation["metadata"] = [];
  const metas: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let receipt: Record<string, unknown> | undefined;
  for (let depth = 0; depth < 6 && record(payload); depth++) {
    if (record(payload.meta)) metas.push(payload.meta);
    if (typeof payload.success === "boolean" && Object.hasOwn(payload, "output")) {
      if (payload.success === false || !receipt) receipt = payload;
      if (typeof payload.error === "string" && payload.error) errors.push(payload.error);
      payload = parsed(payload.output);
    } else if (typeof payload.is_error === "boolean" && Object.hasOwn(payload, "content")) {
      if (payload.is_error === true || !receipt) receipt = payload;
      if (payload.is_error && typeof payload.content === "string") errors.push(payload.content);
      payload = parsed(payload.content);
    } else break;
  }
  const meta = Object.assign({}, ...metas.slice().reverse()) as Record<string, unknown>;
  const name = call.name.replace(/^.*[.:/]/, "").toLowerCase();
  const commandTool = /^(bash|shell|run_command|exec_command|terminal)$/.test(name) || meta.kind === "command";
  const codeTool = /^(js_eval|python_eval|python_exec|js_exec|execute_code)$/.test(name) || /^(exec|execute)$/.test(name) && typeof args.code === "string" || meta.kind === "code";
  const readTool = /^(read_file|read|file_read)$/.test(name);
  const searchTool = /^(search_files|grep|rg|glob|find_files)$/.test(name);
  const command = commandTool ? string(args.command) ?? string(args.cmd) ?? string(meta.command) : undefined;
  const source = codeTool ? string(args.code) ?? string(args.source) ?? string(meta.code) : readTool ? string(args.path) ?? string(args.file_path) : searchTool ? string(args.query) ?? string(args.pattern) : undefined;
  let title = command ?? (codeTool ? `${string(meta.language) ?? (name.includes("python") ? "Python" : name.includes("js") ? "JavaScript" : "Code")}` : readTool && source ? `Read ${source}` : searchTool && source ? `Search ${source}` : call.name.replaceAll("_", " "));
  let output: string | undefined;
  let outputKind: ToolPresentation["outputKind"] = commandTool || codeTool ? "terminal" : typeof payload === "string" ? "text" : "json";
  const add = (label: string, value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
    const text = String(value);
    if (!metadata.some(item => item.label === label && item.value === text)) metadata.push({ label, value: text });
  };
  if (commandTool || codeTool) {
    const data = record(payload) ? payload : {};
    const stdout = string(data.stdout) ?? string(data.output) ?? string(meta.stdout) ?? (codeTool ? string(meta.output) : undefined) ?? string(payload);
    const stderr = string(data.stderr) ?? string(meta.stderr);
    const value = string(data.value);
    const parts = [stdout, stderr, value].filter((part): part is string => part !== undefined && part !== "");
    for (const error of errors) if (!parts.some(part => part.includes(error))) parts.push(error);
    output = parts.join("\n");
    if (stdout === undefined && stderr === undefined && value === undefined && payload !== null && payload !== undefined) { output = toolPresentationText(payload); outputKind = record(payload) || Array.isArray(payload) ? "json" : "terminal"; }
    add("Exit code", data.exitCode ?? data.exit_code ?? meta.exitCode);
    const duration = data.durationMs ?? meta.durationMs;
    if (typeof duration === "number") add("Duration", `${duration} ms`);
    else if (typeof data.wall_time_seconds === "number") add("Duration", `${data.wall_time_seconds} s`);
    if (meta.timedOut === true || data.timedOut === true) add("Timed out", true);
    add("Working directory", args.cwd ?? args.workdir);
    add("Process session", data.session_id);
  } else if (readTool && record(payload) && typeof payload.content === "string") {
    output = payload.content; outputKind = "text";
    if (typeof payload.startLine === "number" && typeof payload.endLine === "number") add("Lines", `${payload.startLine}–${payload.endLine}`);
    add("Total lines", payload.totalLines); add("Next offset", payload.nextOffset);
    if (payload.truncated === true) add("Truncated", true);
  } else if (searchTool && record(payload) && Array.isArray(payload.matches) && payload.matches.every(match => record(match) && typeof match.path === "string" && typeof match.line === "number" && typeof match.content === "string")) {
    output = payload.matches.map(match => `${match.path}:${match.line}: ${match.content}`).join("\n"); outputKind = "text";
    add("Matches", payload.matches.length); if (payload.truncated === true) add("Truncated", true);
    add("Files searched", payload.scannedFiles);
    add("Search path", args.path);
  } else if (payload !== undefined && payload !== null) output = toolPresentationText(payload);
  if (/^(update_todos|write_todos)$/.test(name) && record(payload) && Array.isArray(payload.todos)) {
    title = "Update tasks";
    output = payload.todos.filter(record).map(task => `${task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[→]" : "[ ]"} ${String(task.content ?? "")}`).join("\n");
    outputKind = "text";
  } else if (name === "done" && record(payload) && typeof payload.summary === "string") {
    title = "Finish review"; output = payload.summary; outputKind = "text";
  } else if (name === "save_finding" && record(payload)) {
    title = `Save finding${typeof args.title === "string" ? `: ${args.title}` : ""}`;
    if (typeof payload.message === "string") { output = payload.message; outputKind = "text"; }
    add("Finding ID", payload.findingId);
  } else if (name === "list_files" && record(payload) && Array.isArray(payload.files) && payload.files.every(item => typeof item === "string")) {
    title = `List files${typeof args.path === "string" ? ` in ${args.path}` : ""}`;
    output = payload.files.join("\n"); outputKind = "text";
  }
  if (!output && errors.length) { output = errors.join("\n"); outputKind = "text"; }
  const status = toolCallStatus({ ...call, result: receipt ?? call.result });
  return { title, command, source, input: codeTool ? source : undefined, output, outputKind, status,
    language: codeTool ? string(meta.language) ?? (name.includes("python") ? "python" : "javascript") : undefined,
    metadata, rawArguments: toolPresentationText(call.arguments), rawResult };
}
