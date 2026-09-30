import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
type Phase = "idle" | "running" | "connected" | "failed" | "cancelled" | "unavailable";
interface DeviceAuth { phase: Phase; message: string; verificationUrl?: string; userCode?: string }
interface GithubAccount { available: boolean; connected: boolean; account: string | null; scopes: string[]; deviceAuth: DeviceAuth }

/** Uses the publication CLI's own private account store; never projects tokens. */
export class GitHubPublicationAuth {
  #child: ChildProcess | null = null;
  #state: DeviceAuth = { phase: "idle", message: "Connect GitHub separately before publishing a draft PR." };

  async status(): Promise<GithubAccount> {
    try {
      await execute("gh", ["--version"], { timeout: 5_000, maxBuffer: 64_000 });
    } catch {
      return { available: false, connected: false, account: null, scopes: [], deviceAuth: { phase: "unavailable", message: "GitHub publication requires Git and the GitHub CLI on the local engine host. Model connections are independent." } };
    }
    try {
      const result = await execute("gh", ["auth", "status", "--hostname", "github.com", "--json", "hosts"], { timeout: 10_000, maxBuffer: 64_000 });
      const parsed: unknown = JSON.parse(result.stdout);
      const hosts = parsed && typeof parsed === "object" && "hosts" in parsed ? parsed.hosts : null;
      const accounts = hosts && typeof hosts === "object" && "github.com" in hosts ? hosts["github.com"] : null;
      const active = Array.isArray(accounts) ? accounts.find((entry: unknown) => entry && typeof entry === "object" && "active" in entry && entry.active === true) : undefined;
      const entry = active && typeof active === "object" ? active : null;
      const connected = Boolean(entry && "state" in entry && entry.state === "success");
      const account = entry && "login" in entry && typeof entry.login === "string" ? entry.login : null;
      const scopeValue = entry && "scopes" in entry ? entry.scopes : null;
      const scopes = Array.isArray(scopeValue) ? scopeValue.filter((value: unknown): value is string => typeof value === "string") : typeof scopeValue === "string" ? scopeValue.split(/[,\s]+/).filter(Boolean) : [];
      return { available: true, connected, account, scopes, deviceAuth: connected && this.#state.phase !== "running" ? { phase: "connected", message: "GitHub publication account is connected." } : { ...this.#state } };
    } catch {
      return { available: true, connected: false, account: null, scopes: [], deviceAuth: { ...this.#state } };
    }
  }

  async connect(value: unknown): Promise<GithubAccount> {
    if (this.#child) throw new Error("GitHub authentication is already running.");
    if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string" || !value.token.trim() || value.token.length > 16_000) throw new Error("Enter a valid GitHub publication token.");
    const token = value.token.trim();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], { stdio: ["pipe", "ignore", "pipe"] });
    this.#child = child;
    this.#state = { phase: "running", message: "Validating the publication account." };
    child.once("error", () => { reject(new Error("GitHub authentication could not start.")); });
    child.once("exit", code => { if (code === 0) resolve(); else reject(new Error("GitHub rejected the publication credential or could not save it privately.")); });
    child.stdin?.end(`${token}\n`);
    try { await promise; this.#state = { phase: "connected", message: "GitHub publication account connected." }; }
    catch (error) { this.#state = { phase: "failed", message: error instanceof Error ? error.message : "GitHub authentication failed." }; throw error; }
    finally { if (this.#child === child) this.#child = null; }
    return this.status();
  }

  async start(): Promise<GithubAccount> {
    if (this.#child) return this.status();
    const current = await this.status();
    if (!current.available) return current;
    this.#state = { phase: "running", message: "Requesting an official GitHub device code." };
    const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], { env: { ...process.env, BROWSER: "true", GH_BROWSER: "true" }, stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    let output = "";
    const receive = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8_000);
      const code = /(?:one-time|device) code[^A-Z0-9]*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output)?.[1];
      if (code && this.#state.phase === "running" && !this.#state.userCode) {
        this.#state = { phase: "running", message: "Enter this code on the official GitHub device page.", verificationUrl: "https://github.com/login/device", userCode: code };
        child.stdin?.write("\n");
      }
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.once("error", () => { if (this.#child === child) { this.#child = null; this.#state = { phase: "unavailable", message: "GitHub authentication could not start." }; } });
    child.once("exit", code => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#state = code === 0 ? { phase: "connected", message: "GitHub device authentication completed." } : { phase: "failed", message: "GitHub device authentication did not complete. No publication was authorized." };
    });
    return this.status();
  }

  async cancel(): Promise<GithubAccount> {
    const child = this.#child;
    this.#child = null;
    child?.kill("SIGTERM");
    this.#state = { phase: "cancelled", message: "GitHub authentication cancelled." };
    return this.status();
  }

  dispose(): void { this.#child?.kill("SIGTERM"); this.#child = null; }
}
