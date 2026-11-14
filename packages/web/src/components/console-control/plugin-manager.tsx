import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { useBackendApi } from "@/api";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { Feedback, jsonBody } from "./control-ui";
import { permissionWording } from "./plugin-detail-model";
import type { PluginItem, PluginResult, PluginsResponse } from "./contracts";

export type PluginAction = "install" | "enable" | "run";

/** Registry/GitHub plugin inventory and its install, enable, disable and load actions. Shared by the list, the detail page and Explore so every path goes through the same permission review. */
export function usePluginManager() {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const inventory = useQuery({ queryKey: queryKeys.consolePlugins(), queryFn: ({ signal }) => webFetchJson<PluginsResponse>("/api/console/plugins", { signal }), refetchInterval: 5000 });
  const isolated = inventory.data?.executionProfile === "smolvm";
  const [confirmation, setConfirmation] = useState<{ action: PluginAction; item: PluginItem } | null>(null);
  const [technicalMessage, setTechnicalMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mutate = useMutation({ mutationFn: async ({ action, target, approved = false }: { action: "install" | "enable" | "disable" | "run"; target: PluginItem; approved?: boolean }) => {
    if (target.kind !== "plugin") throw new Error("Only web plugins can be managed here.");
    if ((action === "enable" || action === "run" || action === "install") && !approved) throw new Error("Confirm this action first.");
    const payload = action === "install" ? { id: target.id, kind: target.kind }
      : action === "enable" ? { id: target.id, approved: true, capabilities: target.capabilities, version: target.version }
      : { id: target.id };
    const result = await webFetchJson<PluginResult>(`/api/console/plugins/${action}`, jsonBody(payload));
    if (!result.ok && !(action === "run" && result.deferred)) throw new Error(result.message);
    if (action === "enable" && !isolated) {
      const loaded = await webFetchJson<PluginResult>("/api/console/plugins/run", jsonBody({ id: target.id }));
      if (!loaded.ok && !loaded.deferred) throw new Error(loaded.message);
      return loaded;
    }
    return result;
  }, onSuccess: async (result, { action }) => {
    await Promise.all([inventory.refetch(), queryClient.invalidateQueries({ queryKey: queryKeys.consoleSettings() }), queryClient.invalidateQueries({ queryKey: queryKeys.consoleTools() })]);
    setConfirmation(null);
    setTechnicalMessage(result.message);
    setMessage(action === "enable" ? result.deferred ? "Enabled. Loading after the current response finishes." : "Enabled." : action === "disable" ? v("Disabled for new {missions}.") : action === "install" ? "Installed. Review its permissions, then turn it on." : result.deferred ? "Loading is waiting for the current response to finish." : "Loaded.");
  }, onError: () => { void inventory.refetch(); } });
  const requestConfirmation = (action: PluginAction, target: PluginItem, trigger?: HTMLElement) => { confirmationTrigger.current = trigger ?? null; mutate.reset(); setMessage(null); setConfirmation({ action, item: target }); };
  return { inventory, isolated, mutate, confirmation, setConfirmation, message, setMessage, technicalMessage, requestConfirmation, confirmationTrigger };
}
export type PluginManager = ReturnType<typeof usePluginManager>;

/** Permission review before a registry or GitHub plugin is installed, enabled or loaded. Nothing runs until this is confirmed. */
export function PluginConfirmDialog({ manager }: { manager: PluginManager }) {
  const { confirmation, setConfirmation, mutate, isolated, confirmationTrigger } = manager;
  return <ConfirmDialog open={Boolean(confirmation)} onOpenChange={open => { if (!open) { setConfirmation(null); mutate.reset(); } }} pending={mutate.isPending} spinner
    onCloseAutoFocus={event => { event.preventDefault(); confirmationTrigger.current?.focus(); }}
    title={<>{confirmation?.action === "enable" ? "Enable" : confirmation?.action === "run" ? "Load" : "Add"} {confirmation?.item.name}</>}
    description={confirmation?.action === "enable" ? isolated ? v("Approve this version and its permissions for new SmolVM {missions}. Its files will be copied and its code loaded inside the VM automatically. Existing {missions} keep their current tools.") : v("Approve this version and its permissions, and allow its code to load in the local host. Existing {missions} keep their current tools.") : confirmation?.action === "run" ? "This runs the plugin's code in the local host. An active response may defer loading." : "Install this artifact from the configured registry. It stays off until you review and enable it."}
    confirmLabel={confirmation?.action === "enable" ? "Approve and enable" : confirmation?.action === "run" ? "Allow and load" : "Add plugin"}
    onConfirm={() => { if (confirmation) mutate.mutate({ action: confirmation.action, target: confirmation.item, approved: true }); }}>
    {confirmation && <div className="space-y-3 text-sm"><p className="text-muted-foreground">{confirmation.item.name} {confirmation.item.version}</p>{confirmation.action === "install" && confirmation.item.signature === "unverified" && <p className="leading-6">The signature is unverified. Only install if you trust this source.</p>}{confirmation.action !== "run" && <div><p className="font-medium">Permissions</p>{confirmation.item.capabilities.length ? <ul className="mt-2 list-inside list-disc space-y-1 break-words">{confirmation.item.capabilities.map(capability => <li key={capability}>{permissionWording(capability)}</li>)}</ul> : <p className="mt-2 text-muted-foreground">No extra permissions.</p>}</div>}<Feedback error={mutate.error} /></div>}
  </ConfirmDialog>;
}
