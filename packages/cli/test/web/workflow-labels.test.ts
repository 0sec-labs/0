import { expect, test } from "vitest";
import { assessmentLabel, workflowOperationLabel } from "../../../dashboard/src/components/workflow-labels";

test("source analysis is called Whitebox pentest while web and unknown targets stay distinct", () => {
  for (const target of ["/repo", "./repo", "../repo", "assets/examples/demo-api", "C:\\repo", "https://github.com/example/repo.git"]) {
    expect(assessmentLabel({ target })).toBe("Whitebox pentest");
  }
  expect(assessmentLabel({ target: "", template: { id: "repository-review", revision: 1 } })).toBe("Whitebox pentest");
  expect(assessmentLabel({ target: "https://example.test" })).toBe("Web pentest");
  expect(assessmentLabel({ target: "@example/package" })).toBe("Security assessment");
  expect(assessmentLabel({ target: "" })).toBe("Security assessment");
  expect(workflowOperationLabel({ type: "deep-review" }, { target: "" })).toBe("Whitebox pentest");
  expect(workflowOperationLabel({ type: "verify" }, { target: "/repo" })).toBe("Finding verification");
});
