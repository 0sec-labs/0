import { createExtensionService } from "./index.js";
import type { ImportReport } from "./core/state.js";

/** Run the one-time importer (idempotent). Returns the report, or null when it could not run; startup never fails because of it. */
export function runStartupImport(options: { home?: string } = {}): (ImportReport & { alreadyDone: boolean }) | null {
  try { const r = createExtensionService(options).importer.run(); return r.ok ? r.value : null; } catch { return null; }
}
