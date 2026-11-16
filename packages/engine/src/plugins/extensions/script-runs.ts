/**
 * Scripts of an extension run through the ordinary bash tool. This is the one place that decides what such a run adds to
 * its environment: only the variables the extension declared AND the operator approved, filled from the process
 * environment (for plain declared names) and from the connection's stored secret (for a connector's names). A script of an
 * extension that is not enabled and approved gets nothing, and an extension whose approval does not cover a name it
 * declares is refused outright. The secret values are returned so the caller can mask them in what comes back.
 */
import type { ExtensionRunPort } from "../../agent/types.js";
import { BASE_ENV } from "./core/env.js";
import type { ConnectionSecrets, ExtensionStore } from "./ports.js";
import { loadable } from "./runtime.js";

const BOUNDARY = /[\s/"'`;&|)<>]/;
function mentions(command: string, dir: string): boolean {
  for (let at = command.indexOf(dir); at !== -1; at = command.indexOf(dir, at + 1)) { const next = command[at + dir.length]; if (next === undefined || BOUNDARY.test(next)) return true; }
  return false;
}

export function createScriptRuns(options: { store: ExtensionStore; secrets: ConnectionSecrets; projectKey: string | null; parentEnv?: () => Readonly<Record<string, string | undefined>> }): ExtensionRunPort {
  return {
    prepare(command) {
      const state = options.store.read(); if (!state.ok) return null;
      const named = Object.values(state.value.extensions).filter(e => !e.legacy && e.active && e.revisions[e.active]
        && mentions(command, options.store.revisionPath(e.name, e.active, e.revisions[e.active]!.location))).map(e => e.name);
      if (!named.length) return null;
      const env: Record<string, string> = {}; const secrets: string[] = [];
      const active = loadable(options.store, options.projectKey, options.secrets).extensions.filter(e => named.includes(e.name));
      if (!active.length) return null;
      for (const ext of active) {
        if (ext.unapprovedEnv.length) return { ok: false, error: `extension ${ext.name} declares ${ext.unapprovedEnv.join(", ")} but the approval does not cover it: approve it again with \`0 skills extensions enable ${ext.name} --yes\`` };
        for (const [name, value] of Object.entries(ext.env((options.parentEnv ?? (() => process.env))()))) {
          if (BASE_ENV.includes(name)) continue;
          env[name] = value; if (!name.startsWith("ZERO_EXTENSION_")) secrets.push(value);
        }
      }
      return { ok: true, env, secrets };
    },
  };
}
