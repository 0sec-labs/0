// Aliased as `zod` by vite.config.ts (bundles only). Zod 4 probes `new Function("")` when a schema is built; under our CSP
// (no 'unsafe-eval') that raises a securitypolicyviolation on every page even though the throw is swallowed. Setting
// `jitless` here, before any consumer module evaluates, skips the probe. The interpreter path is fast enough for dashboard payloads.
import { config } from "zod/v4/core";
import * as z from "zod/v4";

config({ jitless: true });
export * from "zod/v4";
export { z, z as default };
