import type { createDrizzleFromShim, ShimmedDatabase } from "../wasm-shim.js";
import type * as schema from "../schema.js";
import type { Repositories } from "./index.js";
import type { osecDB } from "../database.js";

export type OsecDrizzle = ReturnType<typeof createDrizzleFromShim<typeof schema>>;

/** Shared handles every aggregate repository operates on. */
export abstract class Repository {
  constructor(
    protected readonly sqlite: ShimmedDatabase,
    protected readonly db: OsecDrizzle,
    protected readonly repos: Repositories,
    protected readonly owner: osecDB,
  ) {}

  protected transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }
}
