import { settingChoiceLabel, settingLabel, settingToggle, sharedSettingKeys } from "./web-settings";

/** Settings whose defaults can be more permissive than a deliberate choice. Never reset together with display settings. */
export const protectedSettingKeys = ["analyticsLevel", "diagnosticReporting", "updatePolicy", "executionProfile", "allowModelSelfExtension"] as const;
export const isProtectedSetting = (key: string): boolean => (protectedSettingKeys as readonly string[]).includes(key);

type Definition = { key: string; label: string; default: unknown };
export type ResetChange = { key: string; label: string; from: string; to: string };
export type ResetPlan = {
  /** What a reset of this scope will change right now. */
  changes: ResetChange[];
  /** Keys sent to the server. */
  keys: string[];
  /** Safety and privacy settings left as they are (default reset only). */
  untouched: { key: string; label: string; value: string }[];
};

export function describeSettingValue(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  const toggle = settingToggle(key);
  if (toggle && typeof value === "string") return value === toggle.on ? "On" : value === toggle.off ? "Off" : settingChoiceLabel(key, value);
  if (value === "") return "Not set";
  if (key === "archiveIdleDays" && typeof value === "number") return value === 0 ? "Off" : `${value} days`;
  return typeof value === "string" ? settingChoiceLabel(key, value) : String(value ?? "Not set");
}

/**
 * `scope`: "display" resets display and behaviour settings only; "protected" resets only safety and privacy settings;
 * an explicit key list resets exactly those keys. Settings already at their default are not listed.
 */
export function planReset(scope: "display" | "protected" | string[], definitions: Definition[], values: Record<string, unknown>): ResetPlan {
  const shared = new Set(sharedSettingKeys(definitions.map(def => def.key)));
  const wanted = (def: Definition) => shared.has(def.key) && (Array.isArray(scope) ? scope.includes(def.key) : scope === "protected" ? isProtectedSetting(def.key) : !isProtectedSetting(def.key));
  const candidates = definitions.filter(wanted);
  const changes = candidates.filter(def => values[def.key] !== def.default).map(def => ({ key: def.key, label: settingLabel(def), from: describeSettingValue(def.key, values[def.key]), to: describeSettingValue(def.key, def.default) }));
  const untouched = scope === "display" ? definitions.filter(def => shared.has(def.key) && isProtectedSetting(def.key)).map(def => ({ key: def.key, label: settingLabel(def), value: describeSettingValue(def.key, values[def.key]) })) : [];
  return { changes, keys: changes.map(change => change.key), untouched };
}
