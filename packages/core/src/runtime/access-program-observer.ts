import type { AssessmentAccessProgram } from "@0/shared";

/** Keep provider observations separate from selection and from model-generated text. */
export function accessProgramObserver(requested?: AssessmentAccessProgram["requested"], next?: (metadata: AssessmentAccessProgram) => void) {
  let confirmed: AssessmentAccessProgram["confirmed"];
  return {
    metadata: (): AssessmentAccessProgram | undefined => requested ? { requested, ...(confirmed ? { confirmed } : {}) } : undefined,
    observe: (metadata: AssessmentAccessProgram) => {
      confirmed = metadata.requested === requested && ["standard", "daybreak_blue", "daybreak_red"].includes(metadata.confirmed ?? "") ? metadata.confirmed : undefined;
      next?.(metadata);
    },
  };
}
