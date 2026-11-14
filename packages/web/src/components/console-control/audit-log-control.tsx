import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { queryKeys } from "@/queries";
import { useBackendApi } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { CapyChevronDownIcon, CapyChevronUpIcon, CapySlidersIcon } from "@/ui/icons/capy";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/components/table";
import { QueryState } from "./control-ui";
import { SettingsSection } from "./settings-section";
import { AUDIT_EMPTY, auditActionLabel, auditDetailSummary, auditExportJson, auditLogPath, auditWhen, sortAudit, type AuditLogResponse, type AuditSort } from "./audit-log-model";

const headClass = "h-8 px-0 pr-4 text-xs font-normal text-muted-foreground-1 select-none";

/** Append-only record of privileged actions on this engine. Read-only: nothing here can edit or clear it. */
export function AuditLogSettings() {
  const { webFetchJson, client } = useBackendApi();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<AuditSort>("newest");
  useEffect(() => { const timer = setTimeout(() => setQ(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const log = useInfiniteQuery({
    queryKey: queryKeys.settingsAuditLog(client.backendId, q),
    initialPageParam: null as number | null,
    queryFn: ({ signal, pageParam }) => webFetchJson<AuditLogResponse>(auditLogPath({ q, before: pageParam }), { signal }),
    getNextPageParam: page => page.nextBefore,
  });
  const events = useMemo(() => sortAudit(log.data?.pages.flatMap(page => page.events) ?? [], sort), [log.data, sort]);
  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([auditExportJson(events)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "0-audit-log.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const SortIcon = sort === "newest" ? CapyChevronDownIcon : CapyChevronUpIcon;
  return <div className="flex flex-col gap-10">
    <QueryState pending={log.isPending} error={log.error} retry={log.refetch} label="Loading audit log…" />
    {log.data && <SettingsSection id="settings-audit-log" title="Audit log" description="Privileged and security-relevant actions on this engine, stored locally. Secret values are never recorded."
      action={<Button variant="outline" size="sm" disabled={events.length === 0} onClick={exportJson}><Download className="size-4" />Export JSON</Button>}>
      <div id="setting-audit-log-search" tabIndex={-1} className="flex items-center gap-2 border-b-[0.5px] border-border-1 p-3 outline-none">
        <Input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search action or subject" aria-label="Search audit log" />
        <DropdownMenu>
          <DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="Display options" />}><CapySlidersIcon /></DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" className="w-48">
            <DropdownMenu.Label>Order by When</DropdownMenu.Label>
            <DropdownMenu.Item selected={sort === "newest"} onClick={() => setSort("newest")}>Newest first</DropdownMenu.Item>
            <DropdownMenu.Item selected={sort === "oldest"} onClick={() => setSort("oldest")}>Oldest first</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
      {events.length === 0 ? <p role="status" className="p-4 text-sm text-muted-foreground-2">{q ? `No entries match "${q}".` : AUDIT_EMPTY}</p> :
        <Table aria-label="Audit log" className="text-xs">
          <TableHeader className="[&_tr]:border-b-[0.5px] [&_tr]:border-border-1"><TableRow className="border-b-[0.5px] border-border-1 hover:bg-transparent">
            <TableHead className={`${headClass} pl-4`} aria-sort={sort === "newest" ? "descending" : "ascending"}>
              <button type="button" className="inline-flex items-center gap-1 outline-none focus-visible:underline" onClick={() => setSort(sort === "newest" ? "oldest" : "newest")}>When<SortIcon aria-hidden="true" className="size-(--icon-sm)" /></button>
            </TableHead>
            <TableHead className={headClass}>Actor</TableHead><TableHead className={headClass}>Action</TableHead><TableHead className={headClass}>Subject</TableHead>
          </TableRow></TableHeader>
          <TableBody>{events.map(event => {
            const when = auditWhen(event.ts); const summary = auditDetailSummary(event.detail);
            return <TableRow key={event.id} className="border-b-[0.5px] border-border-1 hover:bg-secondary">
              <TableCell className="h-[50px] pl-4 pr-4 text-muted-foreground-1"><Tooltip content={when.exact}><time dateTime={event.ts}>{when.relative}</time></Tooltip></TableCell>
              <TableCell className="px-0 pr-4 text-muted-foreground-1">{event.actor}</TableCell>
              <TableCell className="px-0 pr-4 text-sm font-medium text-foreground"><span className="flex items-center gap-2">{auditActionLabel(event.action)}{event.outcome !== "ok" && <Badge variant="danger">{event.outcome === "denied" ? "Denied" : "Failed"}</Badge>}</span></TableCell>
              <TableCell className="px-0 pr-4 whitespace-normal text-muted-foreground-1"><span className="block break-words">{event.subject}</span>{summary && <span className="block break-words text-muted-foreground-2">{summary}</span>}</TableCell>
            </TableRow>;
          })}</TableBody>
        </Table>}
      {log.hasNextPage && <div className="flex justify-center p-3"><Button variant="ghost" size="sm" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>Load older entries</Button></div>}
    </SettingsSection>}
  </div>;
}
