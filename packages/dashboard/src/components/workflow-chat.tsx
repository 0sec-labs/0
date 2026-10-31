import type { SecurityWorkflow } from "@0/shared";
import { EditorChat } from "./editor-chat";

export function WorkflowChat({ definition, readOnly }: { definition: SecurityWorkflow; readOnly: boolean }) {
  return <EditorChat resource={{ kind: "workflow", id: definition.id, name: definition.name }} readOnly={readOnly} />;
}
