import { MessageSquarePlus, ShieldOff } from "lucide-react";
import { CapyCloseIcon as X } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ReportExportControl } from "@/components/report-export-control";
import { v } from "@/lib/vocabulary";
import { StatusIcon } from "./finding-icons";
import { SETTABLE_STATUSES, STATUS_LABEL, type FindingStatus } from "./findings-model";

/** Floating bar for the current selection. Offers only actions the engine supports: set status, dismiss, export, and (for one finding) hand off to a mission. */
export function FindingsBulkBar({ count, busy, exportPath, onStatus, onDismiss, onAddToMission, onClear }: {
  count: number;
  busy: boolean;
  exportPath: string;
  onStatus: (status: FindingStatus) => void;
  onDismiss: () => void;
  onAddToMission?: () => void;
  onClear: () => void;
}) {
  return (
    <div role="toolbar" aria-label="Bulk actions" className="pointer-events-auto absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border-[0.5px] border-border-2 bg-popover p-1 pl-3 text-sm text-popover-foreground shadow-[var(--sh-overlay,0_6px_18px_rgb(0_0_0/.08))]">
      <span className="mr-1 text-xs font-medium tabular-nums whitespace-nowrap" aria-live="polite">{count} selected</span>
      <DropdownMenu>
        <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" disabled={busy} />}>Status</DropdownMenu.Trigger>
        <DropdownMenu.Content align="center" side="top" className="w-44">
          {SETTABLE_STATUSES.map(status => <DropdownMenu.Item key={status} icon={<StatusIcon status={status} />} onClick={() => onStatus(status)}>{STATUS_LABEL[status]}</DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onDismiss}><ShieldOff />Dismiss</Button>
      {onAddToMission ? <Button variant="ghost" size="sm" onClick={onAddToMission}><MessageSquarePlus />{v("Add to {mission}")}</Button> : null}
      <ReportExportControl label="Export" path={exportPath} />
      <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}><X /></Button>
    </div>
  );
}
