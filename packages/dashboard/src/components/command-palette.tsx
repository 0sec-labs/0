import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { FileSearch, LayoutDashboard, MessageSquare, PlayCircle, Settings, ShieldCheck, ShieldOff, SlidersHorizontal } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getFindingFamily, updateFindingFamilyTriage } from "@/api";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { DashboardResponse, ScanRecord } from "@/types";

type PaletteAction = {
  id: string;
  group: "Actions" | "Pages" | "Findings" | "Runs";
  label: string;
  meta: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
  keywords: string[];
  shortcut?: string;
};

const GROUPS: PaletteAction["group"][] = ["Actions", "Pages", "Findings", "Runs"];

export function CommandPalette({
  open,
  onOpenChange,
  dashboard,
  scans,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboard?: DashboardResponse;
  scans?: ScanRecord[];
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const selectedFingerprint = location.pathname.match(/^\/(?:threads|findings)\/([^/]+)/)?.[1] ?? null;
  const selectedScanId = location.pathname.match(/^\/(?:runs|scans)\/([^/]+)/)?.[1] ?? null;

  const selectedFamilyQuery = useQuery({
    queryKey: ["finding-family", selectedFingerprint],
    queryFn: () => getFindingFamily(selectedFingerprint!),
    enabled: open && Boolean(selectedFingerprint),
  });

  const triageMutation = useMutation({
    mutationFn: ({
      triageStatus,
      triageNote,
    }: {
      triageStatus: "new" | "accepted" | "suppressed";
      triageNote: string;
    }) => updateFindingFamilyTriage(selectedFingerprint!, triageStatus, triageNote),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["finding-family", selectedFingerprint] }),
      ]);
    },
  });

  const items = useMemo<PaletteAction[]>(() => {
    const base: PaletteAction[] = [
      {
        id: "page-console",
        group: "Pages",
        label: "Chat",
        meta: "Chat with 0",
        icon: MessageSquare,
        keywords: ["chat operator workspace session scope approvals console"],
        run: () => navigate("/console"),
      },
      {
        id: "new-console",
        group: "Actions",
        label: "New chat",
        meta: "Start a new conversation",
        icon: MessageSquare,
        keywords: ["new conversation chat audit session"],
        run: () => navigate("/console?new=1"),
      },
      ...[
        ["setup", "Setup", "Connect a model and pick a project"],
        ["connections", "Connections", "API keys and accounts"],
        ["models", "Models", "Choose which models 0 uses"],
        ["settings", "Settings", "Preferences, shortcuts, appearance"],
        ["plugins", "Plugins", "Add and manage extensions"],
        ["doctor", "Diagnostics", "Check that everything works"],
        ["tools", "Tools", "What 0 can use"],
        ["project", "Project", "Target and permissions"],
        ["fix", "Fix", "Review and apply a code fix"],
      ].map(([route, label, meta]): PaletteAction => ({
        id: `control-${route}`, group: "Pages", label: label!, meta: meta!, icon: route === "settings" ? Settings : SlidersHorizontal,
        keywords: [route!, label!],
        run: () => {
          const sessionId = location.pathname.match(/^\/console\/([^/]+)/)?.[1];
          navigate(`/${route}${sessionId ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(location.pathname)}` : ""}`);
        },
      })),
      {
        id: "page-findings",
        group: "Pages",
        label: "Findings",
        meta: "Issues 0 found",
        icon: FileSearch,
        keywords: ["findings families review evidence console handoff"],
        run: () => navigate("/findings"),
      },
      {
        id: "page-control",
        group: "Pages",
        label: "Overview",
        meta: "What 0 is doing",
        icon: LayoutDashboard,
        keywords: ["operations dashboard overview workers queue"],
        run: () => navigate("/dashboard"),
      },
      {
        id: "page-scans",
        group: "Pages",
        label: "Workflows",
        meta: "Create and run security workflows",
        icon: PlayCircle,
        keywords: ["workflows automations agents audit security review scans"],
        run: () => navigate("/workflows"),
      },
    ];

    const selectedFindingId = selectedFamilyQuery.data?.latest.id;
    if (selectedFindingId) {
      base.unshift(
        {
          id: "finding-console",
          group: "Actions",
          label: "Investigate this finding",
          meta: "Open it in a new chat",
          icon: MessageSquare,
          keywords: ["finding investigate console chat focus evidence"],
          run: () => navigate(`/console?finding=${encodeURIComponent(selectedFindingId)}&intent=investigate`),
        },
        {
          id: "finding-impact",
          group: "Actions",
          label: "View impact",
          meta: "See how serious this finding is",
          icon: FileSearch,
          keywords: ["finding impact assessment stored"],
          run: () => navigate(`/console?finding=${encodeURIComponent(selectedFindingId)}&intent=impact`),
        },
      );
    }
    if (selectedFingerprint) {
      base.unshift(
        {
          id: "triage-accept",
          group: "Actions",
          label: "Accept finding",
          meta: "Mark as real",
          icon: ShieldCheck,
          keywords: ["accept finding triage"],
          shortcut: "Enter",
          run: () => triageMutation.mutate({
            triageStatus: "accepted",
            triageNote: selectedFamilyQuery.data?.latest.triageNote ?? "",
          }),
        },
        {
          id: "triage-suppress",
          group: "Actions",
          label: "Dismiss finding",
          meta: "Hide it from the list",
          icon: ShieldOff,
          keywords: ["suppress finding triage"],
          shortcut: "Shift+S",
          run: () => triageMutation.mutate({
            triageStatus: "suppressed",
            triageNote: selectedFamilyQuery.data?.latest.triageNote ?? "",
          }),
        },
      );
    }

    if (selectedScanId) {
      base.unshift({
        id: "scan-detail",
        group: "Actions",
        label: "Open this run",
        meta: "Run report",
        icon: PlayCircle,
        keywords: ["scan timeline detail current"],
        run: () => navigate(`/runs/${selectedScanId}`),
      });
    }

    for (const group of dashboard?.groups.slice(0, 14) ?? []) {
      base.push({
        id: `finding-${group.fingerprint}`,
        group: "Findings",
        label: group.latest.title,
        meta: `${group.latest.severity} · ${group.latest.triageStatus}`,
        icon: FileSearch,
        keywords: [group.latest.title, group.latest.category, group.latest.severity, group.latest.triageStatus],
        run: () => navigate(`/findings/${group.fingerprint}`),
      });
    }

    for (const scan of scans?.slice(0, 14) ?? []) {
      base.push({
        id: `scan-${scan.id}`,
        group: "Runs",
        label: scan.target?.trim() || `Run ${scan.id.slice(0, 8)}`,
        meta: scan.status,
        icon: PlayCircle,
        keywords: [scan.target, scan.status, scan.depth, scan.runtime, scan.mode],
        run: () => navigate(`/runs/${scan.id}`),
      });
    }

    return base;
  }, [
    dashboard?.groups,
    navigate,
    queryClient,
    scans,
    selectedFingerprint,
    selectedFamilyQuery.data?.latest.triageNote,
    location.pathname,
    selectedFamilyQuery.data?.latest.id,
    selectedScanId,
    triageMutation,
  ]);

  const filteredItems = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase();
    if (!normalized) return items;

    return items.filter((item) =>
      [item.label, item.meta, ...item.keywords]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [deferredQuery, items]);

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Commands</DialogTitle>
          <DialogDescription>Go to a page, run or finding.</DialogDescription>
        </DialogHeader>

        <div className="border-b border-border px-4 py-3">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages, runs, findings…"
            aria-label="Search commands"
          />
        </div>

        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-1 p-2">
            {GROUPS.map((group) => {
              const entries = filteredItems.filter((item) => item.group === group);
              if (entries.length === 0) return null;

              return (
                <section key={group} className="space-y-1">
                  <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {group}
                  </div>
                  {entries.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        item.run();
                        onOpenChange(false);
                      }}
                      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent"
                    >
                      <div className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-muted text-primary-text">
                        <item.icon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-foreground">{item.label}</div>
                        {item.group !== "Pages" && <div className="truncate text-xs text-muted-foreground">{item.meta}</div>}
                      </div>
                      {item.shortcut ? (
                        <div className="text-xs tracking-widest text-muted-foreground">{item.shortcut}</div>
                      ) : null}
                    </button>
                  ))}
                </section>
              );
            })}

            {filteredItems.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No results.
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
