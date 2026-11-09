import type { ConsoleRuntimeSnapshot } from "@0/shared";
import { useBackendApi } from "@/api";
import { configureChatRuntime } from "./model-source";
import { AccessProgramControl } from "./access-program-control";
import type { ConsoleWorkspace } from "./use-console-workspace";

export function AccessProgramPicker({ workspace, sessionId, runtime, disabled }: {
  workspace: ConsoleWorkspace; sessionId: string; runtime?: ConsoleRuntimeSnapshot | null; disabled: boolean;
}) {
  const api = useBackendApi();
  return <AccessProgramControl configuration={runtime?.accessProgram} disabled={disabled || workspace.busy}
    onChange={cyberAccessProgram => { void workspace.perform(() => configureChatRuntime(api, sessionId, { cyberAccessProgram }, runtime), sessionId); }} />;
}
