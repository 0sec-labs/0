// TargetRepository: persistence for targets.
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { TargetInfo } from "@0/shared";
import * as schema from "../schema.js";

import { Repository } from "./base.js";

export class TargetRepository extends Repository {

  // ── Targets ──

  upsertTarget(info: TargetInfo): string {
    const existing = this.db
      .select({ id: schema.targets.id })
      .from(schema.targets)
      .where(eq(schema.targets.url, info.url))
      .get();

    if (existing) {
      this.db
        .update(schema.targets)
        .set({
          type: info.type,
          model: info.model ?? null,
          systemPrompt: info.systemPrompt ?? null,
          detectedFeatures: info.detectedFeatures
            ? JSON.stringify(info.detectedFeatures)
            : null,
          endpoints: info.endpoints ? JSON.stringify(info.endpoints) : null,
          lastSeenAt: new Date().toISOString(),
        })
        .where(eq(schema.targets.id, existing.id))
        .run();
      return existing.id;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.insert(schema.targets).values({
      id,
      url: info.url,
      type: info.type,
      model: info.model ?? null,
      systemPrompt: info.systemPrompt ?? null,
      detectedFeatures: info.detectedFeatures
        ? JSON.stringify(info.detectedFeatures)
        : null,
      endpoints: info.endpoints ? JSON.stringify(info.endpoints) : null,
      firstSeenAt: now,
      lastSeenAt: now,
    }).run();
    return id;
  }


  getTarget(url: string) {
    return this.db
      .select()
      .from(schema.targets)
      .where(eq(schema.targets.url, url))
      .get();
  }
}
