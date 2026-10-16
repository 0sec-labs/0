import { z } from "zod";
import { ImpactAssessmentSchema } from "@0/shared";
import { osecDB } from "@0/db";

export interface FindingImpactRequestOptions { dbPath?: string; db?: osecDB }
/** Called after engine authentication; request data never chooses storage or execution authority. */
export function handleFindingImpactRequest(pathname: string, method: string, input: unknown, options: FindingImpactRequestOptions): { status: number; data: unknown } | null {
  const match = /^\/api\/findings\/([^/]+)\/impact-assessment$/.exec(pathname);
  if (!match) return null;
  if (method !== "POST" && method !== "DELETE") return { status: 405, data: { error: "Use POST to update or DELETE to clear a business impact assessment." } };
  let findingId: string;
  let assessment: z.infer<typeof ImpactAssessmentSchema> | null;
  try {
    findingId = z.string().trim().min(1).max(160).parse(decodeURIComponent(match[1]!));
    if (/[\x00-\x1f\x7f]/.test(findingId)) throw new Error("Invalid finding ID.");
    if (method === "DELETE") {
      if (input !== undefined) z.object({}).strict().parse(input);
      assessment = null;
    } else {
      // Shared validation strips extensions for model outputs; this mutation endpoint is closed.
      assessment = { ...ImpactAssessmentSchema.strict().parse(input), assessment_source: "provided" };
    }
  } catch (error) {
    return { status: 400, data: { error: error instanceof Error ? error.message : "Invalid impact assessment." } };
  }
  const db = options.db ?? new osecDB(options.dbPath);
  try {
    if (!db.updateFindingImpactAssessment(findingId, assessment)) return { status: 404, data: { error: "Finding was not found in this engine." } };
    return { status: 200, data: { findingId, impactAssessment: assessment } };
  } finally { if (!options.db) db.close(); }
}
