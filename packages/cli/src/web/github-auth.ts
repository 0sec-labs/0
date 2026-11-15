import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { ConsoleGatewayError } from "./console-gateway.js";
import { audit } from "./audit.js";
import {
  GITHUB_SCOPE_REFRESH_HINT, GITHUB_SIGN_IN_SCOPES, classifyLoginFailure, missingScopes, parseAuthStatus, parseDeviceCode, parseTokenExpiry, scrubbedGhEnv,
  type GithubTokenSource,
} from "./github-gh-output.js";

const execute = promisify(execFile);
export const GITHUB_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const EXPIRY_CACHE_MS = 5 * 60_000;

export type GithubPhase = "idle" | "running" | "connected" | "failed" | "cancelled" | "timeout" | "unavailable";
export type GithubAuthMode = "login" | "refresh";
interface DeviceAuth { phase: GithubPhase; message: string; verificationUrl?: string; userCode?: string }
export interface GithubAccount {
  available: boolean;
  connected: boolean;
  account: string | null;
  scopes: string[];
  /** Scopes pull requests need that this login lacks (classic/OAuth logins only). */
  missingScopes: string[];
  refreshCommand: string | null;
  /** Where the login lives: the GitHub CLI's own store, or a GH_TOKEN/GITHUB_TOKEN environment variable. */
  source: GithubTokenSource | null;
  expiresAt: string | null;
  /** The computer the sign-in runs on. */
  computer: string;
  deviceAuth: DeviceAuth;
}
/** Validates the optional `{ mode }` body of POST github/device-auth. */
export function parseAuthMode(input: unknown): GithubAuthMode {
  const mode = input && typeof input === "object" && "mode" in input ? input.mode : undefined;
  if (mode === undefined || mode === "login") return "login";
  if (mode === "refresh") return "refresh";
  throw new ConsoleGatewayError("Unknown sign-in mode.", 400);
}
export interface GitHubAuthOptions { timeoutMs?: number; computer?: string }

/**
 * All GitHub access goes through the GitHub CLI's own login. This class never reads, stores or returns a
 * token: `gh` resolves its credential itself for every API call, repository listing, pull request and catalog fetch.
 */
export class GitHubPublicationAuth {
  #child: ChildProcess | null = null;
  #timer: NodeJS.Timeout | null = null;
  #state: DeviceAuth = { phase: "idle", message: "" };
  #expiry: { account: string; at: number; value: string | null } | null = null;
  readonly #timeoutMs: number;
  readonly #computer: string;
  constructor(options: GitHubAuthOptions = {}) { this.#timeoutMs = options.timeoutMs ?? GITHUB_SIGN_IN_TIMEOUT_MS; this.#computer = options.computer ?? hostname(); }

  #empty(partial: Partial<GithubAccount> & { deviceAuth: DeviceAuth }): GithubAccount {
    return { available: true, connected: false, account: null, scopes: [], missingScopes: [], refreshCommand: null, source: null, expiresAt: null, computer: this.#computer, ...partial };
  }

  async status(): Promise<GithubAccount> {
    try {
      await execute("gh", ["--version"], { timeout: 5_000, maxBuffer: 64_000 });
    } catch {
      return this.#empty({ available: false, deviceAuth: { phase: "unavailable", message: "GitHub CLI is not installed on this computer." } });
    }
    try {
      const result = await execute("gh", ["auth", "status", "--hostname", "github.com", "--json", "hosts"], { timeout: 10_000, maxBuffer: 64_000 });
      const parsed = parseAuthStatus(result.stdout);
      const missing = parsed.connected ? missingScopes(parsed.scopes) : [];
      const expiresAt = parsed.connected && parsed.account ? await this.#expiryFor(parsed.account) : null;
      return this.#empty({
        connected: parsed.connected, account: parsed.account, scopes: parsed.scopes, missingScopes: missing, refreshCommand: missing.length ? GITHUB_SCOPE_REFRESH_HINT : null, source: parsed.source, expiresAt,
        deviceAuth: parsed.connected && this.#state.phase !== "running" ? { phase: "connected", message: "" } : { ...this.#state },
      });
    } catch {
      return this.#empty({ deviceAuth: { ...this.#state } });
    }
  }

  async #expiryFor(account: string): Promise<string | null> {
    const cached = this.#expiry;
    if (cached && cached.account === account && Date.now() - cached.at < EXPIRY_CACHE_MS) return cached.value;
    let value: string | null = null;
    try {
      const { stdout } = await execute("gh", ["api", "--include", "--hostname", "github.com", "user"], { timeout: 10_000, maxBuffer: 1_000_000 });
      value = parseTokenExpiry(stdout.slice(0, stdout.indexOf("\n\n") >= 0 ? stdout.indexOf("\n\n") : undefined));
    } catch { /* Expiry is informational. */ }
    this.#expiry = { account, at: Date.now(), value };
    return value;
  }

  /** Validates a pasted token with the GitHub CLI before saving it in the CLI's own store. */
  async connect(value: unknown): Promise<GithubAccount> {
    if (this.#child) throw new ConsoleGatewayError("GitHub sign-in is already in progress.", 409);
    if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string" || !value.token.trim() || value.token.length > 16_000 || /\s/.test(value.token.trim())) throw new ConsoleGatewayError("Enter a GitHub token.", 400);
    const token = value.token.trim();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], { env: scrubbedGhEnv(process.env), stdio: ["pipe", "ignore", "pipe"] });
    this.#child = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000); });
    this.#state = { phase: "running", message: "Checking the token." };
    child.once("error", () => { reject(new ConsoleGatewayError("GitHub could not be started on this computer.", 500)); });
    child.once("exit", code => {
      if (code === 0) { resolve(); return; }
      const failure = classifyLoginFailure(stderr);
      reject(failure === "rejected" ? new ConsoleGatewayError("GitHub did not accept this token.", 422) : new ConsoleGatewayError("The token could not be saved on this computer.", 500));
    });
    child.stdin?.on("error", () => { /* Early exit closes the pipe. */ });
    child.stdin?.end(`${token}\n`);
    try { await promise; this.#state = { phase: "connected", message: "" }; this.#expiry = null; }
    catch (error) { this.#state = { phase: "failed", message: error instanceof Error ? error.message : "GitHub sign-in failed." }; throw error; }
    finally { if (this.#child === child) this.#child = null; }
    return this.status();
  }

  /** Single-flight `gh auth login --web` (or `gh auth refresh` to add missing scopes). Killed on cancel and after five minutes. */
  async start(mode: GithubAuthMode = "login"): Promise<GithubAccount> {
    if (this.#child) return this.status();
    const current = await this.status();
    if (!current.available) return current;
    this.#state = { phase: "running", message: "Requesting a code from GitHub." };
    const args = mode === "refresh"
      ? ["auth", "refresh", "--hostname", "github.com", "--scopes", "repo"]
      : ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", GITHUB_SIGN_IN_SCOPES];
    const child = spawn("gh", args, { env: scrubbedGhEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    let output = "";
    const receive = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8_000);
      const found = parseDeviceCode(output);
      if (found && this.#child === child && this.#state.phase === "running" && !this.#state.userCode) {
        this.#state = { phase: "running", message: "", ...found };
        child.stdin?.write("\n");
      }
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.stdin?.on("error", () => { /* Early exit closes the pipe. */ });
    this.#timer = setTimeout(() => {
      if (this.#child !== child) return;
      this.#release(child);
      this.#state = { phase: "timeout", message: "The code expired." };
      child.kill("SIGTERM");
    }, this.#timeoutMs);
    this.#timer.unref();
    child.once("error", () => { if (this.#child === child) { this.#release(child); this.#state = { phase: "unavailable", message: "GitHub CLI could not start." }; } });
    child.once("exit", code => {
      if (this.#child !== child) return;
      this.#release(child);
      this.#expiry = null;
      this.#state = code === 0 ? { phase: "connected", message: "" } : { phase: "failed", message: "GitHub sign-in did not finish." };
      audit({ action: code === 0 ? "github.auth.connected" : "github.auth.failed", actor: "operator (browser)", subject: "github", detail: { mode } });
    });
    return this.status();
  }

  #release(child: ChildProcess): void {
    if (this.#child === child) this.#child = null;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
  }

  async cancel(): Promise<GithubAccount> {
    const child = this.#child;
    if (child) { this.#release(child); child.kill("SIGTERM"); this.#state = { phase: "cancelled", message: "Sign-in cancelled." }; }
    return this.status();
  }

  /** Signs the GitHub CLI out of github.com on this computer. A GH_TOKEN/GITHUB_TOKEN environment login cannot be removed from here. */
  async disconnect(): Promise<GithubAccount> {
    if (this.#child) throw new ConsoleGatewayError("GitHub sign-in is in progress. Cancel it first.", 409);
    const current = await this.status();
    if (!current.available) throw new ConsoleGatewayError("GitHub CLI is not installed on this computer.", 409);
    if (!current.connected || !current.account) return current;
    if (current.source === "environment") throw new ConsoleGatewayError("This login comes from an environment variable on this computer. Unset it to disconnect.", 409);
    try {
      await execute("gh", ["auth", "logout", "--hostname", "github.com", "--user", current.account], { env: scrubbedGhEnv(process.env), timeout: 15_000, maxBuffer: 64_000 });
    } catch { throw new ConsoleGatewayError("GitHub could not be disconnected on this computer.", 500); }
    this.#state = { phase: "idle", message: "" };
    this.#expiry = null;
    return this.status();
  }

  dispose(): void { const child = this.#child; if (child) { this.#release(child); child.kill("SIGTERM"); } }
}
