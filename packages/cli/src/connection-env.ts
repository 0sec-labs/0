import { credentialEnvPatch, loadCredentials } from "./tui/credential-store.js";
import { connectionConfigEnvPatch } from "./web/connection-config.js";

/** Saved API-key connections augment local execution; explicit exports win. */
export function savedConnectionEnvPatch(env: NodeJS.ProcessEnv, homeDir?: string): Record<string, string> {
  return {
    ...connectionConfigEnvPatch(env, homeDir),
    ...credentialEnvPatch(loadCredentials(homeDir), env),
  };
}
