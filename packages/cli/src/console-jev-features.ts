import type { JevFeature } from "@0/shared";

const FEATURES = new Set<JevFeature>(["browser", "memory", "dedupe", "redteam", "kernel", "crash", "radar", "foxguard"]);

/** Match existing console opt-in: credentials alone never enable data egress. */
export function consoleJevFeatures(environment: Readonly<Record<string, string | undefined>> = process.env): JevFeature[] {
  return [...new Set((environment.ZERO_JEV_FEATURES ?? "").split(",").map(value => value.trim())
    .filter((value): value is JevFeature => FEATURES.has(value as JevFeature)))];
}
