/** Native plan UI adapter. Only safe profile summaries enter view state. */
import { defaultOpenBrowser } from "../open-browser.js";
import { listChatGptPlanProfiles, signInChatGptPlan, type ChatGptPlanSummary } from "./chatgpt-plan-store.js";
import { providerStates, type ProviderState } from "./provider-status.js";
import type { DeviceAuthSession, DeviceAuthUpdate } from "./device-auth.js";

export function nativePlanProviderStates(env: Record<string, string | undefined>, homeDir?: string,
  inventory: (homeDir?: string) => ChatGptPlanSummary[] = listChatGptPlanProfiles): ProviderState[] {
  let configured = false;
  try { configured = inventory(homeDir ?? env.HOME).some(profile => profile.active && profile.status === "connected" && profile.sharing); }
  catch { /* Invalid/private storage is unavailable, never a configured connection. */ }
  return providerStates(env).map(state => state.id === "chatgpt-plan"
    ? { ...state, configured, via: configured ? "Private ChatGPT connection" : undefined } : state);
}

export interface StartPlanConnectOptions {
  homeDir?: string;
  onUpdate: (update: DeviceAuthUpdate) => void;
  onConnected: () => void;
  /** Injection for offline tests; production owns the protected profile store. */
  signIn?: typeof signInChatGptPlan;
  inventory?: (homeDir?: string) => ChatGptPlanSummary[];
  openBrowser?: (url: string) => void | Promise<void>;
}
export function startChatGptPlanConnect(options: StartPlanConnectOptions): DeviceAuthSession {
  const controller = new AbortController();
  let settled = false;
  const publish = (phase: DeviceAuthUpdate["phase"], message: string) => options.onUpdate({ phase, message, lines: [] });
  const finish = (phase: DeviceAuthUpdate["phase"], message: string) => {
    if (settled) return;
    settled = true; publish(phase, message);
  };
  publish("running", "Complete ChatGPT sign-in in your browser and allow plan usage.");
  void Promise.resolve().then(async () => {
    controller.signal.throwIfAborted();
    const inventory = options.inventory ?? listChatGptPlanProfiles;
    const existing = inventory(options.homeDir).find(profile => profile.active);
    await (options.signIn ?? signInChatGptPlan)({
      homeDir: options.homeDir, profileId: existing?.id, signal: controller.signal,
      onAuthorize: options.openBrowser ?? defaultOpenBrowser,
    });
    controller.signal.throwIfAborted();
    if (!inventory(options.homeDir).some(profile => profile.active && profile.status === "connected" && profile.sharing)) {
      finish("failed", "ChatGPT identity connected, but plan usage was not granted. Reconnect and allow plan usage.");
      return;
    }
    finish("connected", "ChatGPT plan connection saved. Model access is checked when you use it.");
    options.onConnected();
  }).catch(() => finish(controller.signal.aborted ? "cancelled" : "failed", controller.signal.aborted
    ? "ChatGPT sign-in cancelled." : "ChatGPT sign-in could not finish. Retry the connection and check its permissions."));
  return { cancel() {
    if (settled) return;
    controller.abort(); finish("cancelled", "ChatGPT sign-in cancelled.");
  } };
}
