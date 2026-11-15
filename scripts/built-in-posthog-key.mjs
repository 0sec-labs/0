// Build-time resolution of the optional release PostHog project key.
//
// ZERO_RELEASE_POSTHOG_KEY is set only by the release workflow. Unset or empty
// means "not provisioned" (source builds, PR builds, forks): such builds embed
// nothing and therefore send no usage analytics. A set but malformed value
// throws so a bad secret fails the bundle instead of embedding garbage. The
// value is never echoed in errors or logs. (A PostHog project key is a public
// ingestion key, but it is still handled like the Sentry DSN.)
//
// CLI: `node scripts/built-in-posthog-key.mjs` prints the validated key (or an
// empty line) for shell callers that capture it; do not run it with tracing on.

import { pathToFileURL } from "node:url";

const ENV_NAME = "ZERO_RELEASE_POSTHOG_KEY";
const KEY = /^phc_[A-Za-z0-9]{20,}$/;

export function isValidPostHogKey(key) {
  return typeof key === "string" && KEY.test(key);
}

/** Returns the key to embed, or "" when none is provisioned. Throws if malformed. */
export function resolveBuildPostHogKey(env = process.env) {
  const key = env[ENV_NAME]?.trim();
  if (!key) return "";
  if (!isValidPostHogKey(key)) {
    throw new Error(`${ENV_NAME} is set but is not a valid PostHog project key (phc_ followed by at least 20 letters or digits); refusing to bundle. The value is not shown.`);
  }
  return key;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${resolveBuildPostHogKey()}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
