// The web server's one merged view of findings: the shared database plus every per-run scan database.
import { FindingsService, resolveOsecDbPath } from "@0/engine/storage";
import { openSharedDb } from "./shared-db.js";

const services = new Map<string, FindingsService>();

/** An explicit database path names that database only; the default console also reads scan run databases. */
export function findingsServiceFor(dbPath: string | undefined): FindingsService {
  const key = dbPath ?? "";
  let service = services.get(key);
  if (!service) {
    service = new FindingsService({
      ...(dbPath ? { sharedDbPath: dbPath, includeRuns: false } : { sharedDbPath: resolveOsecDbPath() }),
      openShared: () => openSharedDb(dbPath),
    });
    services.set(key, service);
  }
  return service;
}
