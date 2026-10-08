import { useState } from "react";
import { Download } from "lucide-react";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { useBackendApi } from "@/api";
import { Button } from "./ui/button";

const formats = [["json", "JSON"], ["markdown", "Markdown"], ["html", "HTML"], ["sarif", "SARIF"], ["pdf", "PDF"]] as const;
export function ReportExportControl({ path, disabled = false, allowedFormats }: { path: string; disabled?: boolean; allowedFormats?: readonly (typeof formats[number][0])[] }) {
  const available = allowedFormats ? formats.filter(([format]) => allowedFormats.includes(format)) : formats;
  const { webFetch, client } = useBackendApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const download = async (format: string) => {
    setBusy(true); setError("");
    try {
      const response = await webFetch(`${path}${path.includes("?") ? "&" : "?"}format=${format}`);
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error || `Export failed (${response.status}).`);
      }
      const blob = await response.blob();
      client.signal.throwIfAborted();
      const filename = response.headers.get("content-disposition")?.match(/filename="([^"\r\n]+)"/)?.[1] || `0-report.${format === "markdown" ? "md" : format}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { if (!client.signal.aborted) setError(cause instanceof Error ? cause.message : "Export failed."); }
    finally { if (!client.signal.aborted) setBusy(false); }
  };
  return <div className="flex flex-col items-end gap-1"><DropdownMenu><DropdownMenu.Trigger render={<Button variant="outline" size="sm" disabled={disabled || busy || available.length === 0} />}><Download className="size-4" />{busy ? "Exporting…" : "Export"}</DropdownMenu.Trigger><DropdownMenu.Content align="end">{available.map(([format, label]) => <DropdownMenu.Item key={format} onClick={() => void download(format)}>{label}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu>{error && <span role="alert" className="max-w-64 text-xs text-destructive">{error}</span>}</div>;
}
