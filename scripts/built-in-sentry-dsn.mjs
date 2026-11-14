// Build-time resolution of the optional release Sentry DSN.
//
// ZERO_RELEASE_SENTRY_DSN is set only by the release workflow. Unset or empty
// means "not provisioned" (source builds, PR builds, forks). A set but
// malformed value throws so a bad secret fails the bundle instead of embedding
// garbage. The value is never echoed in errors or logs.
//
// CLI: `node scripts/built-in-sentry-dsn.mjs` prints the validated DSN (or an
// empty line) for shell callers that capture it; do not run it with tracing on.

import { pathToFileURL } from "node:url";

const ENV_NAME = "ZERO_RELEASE_SENTRY_DSN";
const TOKEN = /^[A-Za-z0-9_-]+$/;

export function isValidSentryDsn(dsn) {
  try {
    const parsed = new URL(dsn);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const project = segments.pop();
    return parsed.protocol === "https:" && !parsed.password && !parsed.search && !parsed.hash &&
      TOKEN.test(parsed.username) && !!project && /^\d+$/.test(project) &&
      segments.every((segment) => TOKEN.test(segment));
  } catch {
    return false;
  }
}

/** Returns the DSN to embed, or "" when none is provisioned. Throws if malformed. */
export function resolveBuildSentryDsn(env = process.env) {
  const dsn = env[ENV_NAME]?.trim();
  if (!dsn) return "";
  if (!isValidSentryDsn(dsn)) {
    throw new Error(`${ENV_NAME} is set but is not a valid https Sentry DSN (https://<key>@<host>/<project-id>); refusing to bundle. The value is not shown.`);
  }
  return dsn;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${resolveBuildSentryDsn()}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
