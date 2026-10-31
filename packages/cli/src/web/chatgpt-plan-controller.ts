import { listChatGptPlanProfiles, signInChatGptPlan } from "../tui/chatgpt-plan-store.js";
import type { WebAuthStatus } from "./codex-auth-controller.js";

type SignIn = typeof signInChatGptPlan;
export interface ChatGptPlanAuthControllerOptions {
  homeDir?: string;
  signIn?: SignIn;
  list?: typeof listChatGptPlanProfiles;
}
/** Local daemon owns the protocol and credentials; renderer receives only a safe authorize URL. */
export class ChatGptPlanAuthController {
  readonly #options: ChatGptPlanAuthControllerOptions;
  #abort?: AbortController;
  #epoch = 0;
  #status: WebAuthStatus = { phase: "idle", message: "Connect your ChatGPT account.", lines: [], verificationUrl: null, userCode: null, available: true };
  constructor(options: ChatGptPlanAuthControllerOptions = {}) { this.#options = options; }
  status(): WebAuthStatus {
    if (this.#status.phase !== "running" && this.#status.phase !== "failed" && this.#status.phase !== "cancelled") {
      const active = (this.#options.list ?? listChatGptPlanProfiles)(this.#options.homeDir).find(p => p.active && p.status === "connected");
      if (active) return { ...this.#status, phase: "connected", message: active.sharing ? "ChatGPT plan sharing is connected." : "ChatGPT identity is connected. Grant plan usage to use models.", lines: [], verificationUrl: null };
    }
    return { ...this.#status, lines: [...this.#status.lines] };
  }
  start(profileId?: string): WebAuthStatus {
    if (this.#abort) return this.status();
    const epoch = ++this.#epoch, abort = new AbortController(); this.#abort = abort;
    this.#status = { ...this.#status, phase: "running", message: "Starting ChatGPT sign-in.", verificationUrl: null, lines: [] };
    void Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      return (this.#options.signIn ?? signInChatGptPlan)({
      homeDir: this.#options.homeDir, profileId, signal: abort.signal,
      onAuthorize: (value) => {
        if (epoch !== this.#epoch || abort.signal.aborted) return;
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || url.port || url.username || url.password || url.hash || ["access_token", "refresh_token", "id_token", "id_token_hint", "api_key"].some(key => url.searchParams.has(key))) throw new Error("Unsafe authorization destination.");
        this.#status = { ...this.#status, message: "Continue in your browser to connect ChatGPT.", verificationUrl: url.href };
      },
    });
    }).then(() => {
      if (epoch !== this.#epoch || abort.signal.aborted) return;
      this.#status = { ...this.#status, phase: "connected", verificationUrl: null, message: "ChatGPT sign-in completed." };
    }, () => {
      if (epoch !== this.#epoch || abort.signal.aborted) return;
      // Provider errors can contain callback codes or token responses. Never send them to the renderer.
      this.#status = { ...this.#status, phase: "failed", verificationUrl: null, message: "ChatGPT sign-in failed. Retry the connection." };
    }).finally(() => { if (epoch === this.#epoch) this.#abort = undefined; });
    return this.status();
  }
  cancel(): WebAuthStatus {
    ++this.#epoch; this.#abort?.abort(); this.#abort = undefined;
    this.#status = { ...this.#status, phase: "cancelled", message: "ChatGPT sign-in cancelled.", verificationUrl: null, lines: [] };
    return this.status();
  }
}
