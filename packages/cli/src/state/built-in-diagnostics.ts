// Release-provisioned diagnostics destination.
//
// Release builds embed the DSN via the bundler define `__ZERO_BUILT_IN_SENTRY_DSN__`
// (scripts/bundle-cli.mjs, scripts/bun-compile.sh) from the ZERO_RELEASE_SENTRY_DSN
// secret. Source and PR builds leave it unset. Never log this value. Embedding it
// grants no consent: submission still follows diagnosticReporting and the opt-outs.
declare const __ZERO_BUILT_IN_SENTRY_DSN__: string | undefined;

/** The embedded DSN, or undefined when this build was not provisioned. */
export function getBuiltInSentryDsn(): string | undefined {
  if (typeof __ZERO_BUILT_IN_SENTRY_DSN__ === "undefined") return undefined;
  const dsn = __ZERO_BUILT_IN_SENTRY_DSN__?.trim();
  return dsn ? dsn : undefined;
}
