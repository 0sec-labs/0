import { useMemo, type ReactNode } from "react";
import { ChevronDown, Monitor, Server } from "lucide-react";
import { useBackendApi } from "@/api";
import { useBackendSelection } from "@/backend-context";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ModelPicker, isModelEnabled } from "@/components/model-picker";
import { useModelCatalog } from "@/console/use-model-catalog";
import { readLastModelChoice } from "@/lib/last-model-choice";
import { THIS_COMPUTER, type AgentModelPick } from "@/lib/agent-create-model";

/** One labelled row of the create and Profile dialogs: label on the left, its control on the right. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-h-12 items-center justify-between gap-4 border-b-[0.5px] border-border-1 py-1"><span className="text-sm font-medium">{label}</span><div className="flex min-w-0 justify-end">{children}</div></div>;
}

const computerName = (id: string, name?: string) => id === THIS_COMPUTER ? "This computer" : name || id;

/** The Computer row: which computer runs it. `value` is a backend id; "local" is this computer. */
export function ComputerRow({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const backends = useBackendSelection()?.backends ?? [];
  const computers = backends.length > 0 ? backends : [{ id: THIS_COMPUTER, name: "This computer", status: "connected" }];
  const current = computers.find(item => item.id === value);
  const Icon = value === THIS_COMPUTER ? Monitor : Server;
  return <Row label="Computer">
    <DropdownMenu>
      <DropdownMenu.Trigger aria-label="Computer" disabled={disabled} render={<Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-56 gap-1.5 font-normal" />}>
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-icon-muted" /><span className="min-w-0 truncate">{computerName(value, current?.name)}</span><ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground-2" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="w-64">
        {computers.map(item => <DropdownMenu.Item key={item.id} selected={item.id === value} onClick={() => onChange(item.id)}>{computerName(item.id, item.name)}</DropdownMenu.Item>)}
      </DropdownMenu.Content>
    </DropdownMenu>
  </Row>;
}

/** The Model row. `value` null follows the current default model. */
export function ModelRow({ value, onChange, enabled, disabled }: { value: AgentModelPick | null; onChange: (pick: AgentModelPick) => void; enabled: boolean; disabled?: boolean }) {
  const { client, webFetchJson } = useBackendApi();
  const catalog = useModelCatalog({ backendId: client.backendId, webFetchJson, enabled });
  const models = useMemo(() => (catalog.data?.models ?? []).filter(isModelEnabled), [catalog.data]);
  const fallback = readLastModelChoice(client.backendId) ?? (() => { const pick = catalog.data?.recommended?.find(item => item.role === "orchestrator") ?? catalog.data?.recommended?.[0]; return pick ? { providerId: pick.providerId, model: pick.model } : undefined; })();
  return <Row label="Model">
    <ModelPicker label="Default model" models={models} recommended={catalog.data?.recommended ?? []} backendId={client.backendId} pending={catalog.isPending} onOpen={catalog.refreshIfStale} disabled={disabled}
      selected={value ?? fallback} triggerClassName="h-8 w-auto max-w-56 border-transparent bg-transparent px-2 shadow-none" onSelect={item => onChange({ providerId: item.provider, model: item.id })} />
  </Row>;
}
