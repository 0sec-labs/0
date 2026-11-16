import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beginExecutionResource } from "../../../../agent/execution-resource-registry.js";
import type { McpConnector, McpLaunch, McpSession } from "../ports.js";
import { connectSdk, type SessionOptions } from "./sdk-session.js";

/** Starts a server process with exactly the environment it is given (the SDK adds only its small safe default set). */
export class StdioMcpConnector implements McpConnector {
  constructor(private readonly options: SessionOptions = {}) {}
  async connect(launch: McpLaunch): Promise<McpSession> {
    if (launch.kind !== "stdio") throw new Error("not a stdio launch");
    const transport = new StdioClientTransport({ command: launch.command, args: [...launch.args], env: { ...launch.env }, cwd: launch.cwd });
    // Register the child so the thread's resource drain can stop it, the same as every other process the engine starts.
    const creation = beginExecutionResource(); const start = transport.start.bind(transport); let settled = false; let started = false;
    const register = () => { if (!settled && transport.pid) { creation.register({ pid: transport.pid }); settled = true; } };
    transport.start = async () => {
      started = true;
      try { const pending = start(); register(); await pending; register(); }
      catch (error) { register(); if (!settled) creation.failed(); throw error; }
    };
    try { return await connectSdk(transport, this.options); }
    catch (error) { if (!started) creation.failed(); throw error; }
  }
}
