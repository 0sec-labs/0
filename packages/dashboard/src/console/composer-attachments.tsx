import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Paperclip, X } from "lucide-react";

export interface ComposerAttachment { id: string; kind: "image" | "text"; value: string; name: string }
const MAX_TOTAL = 650_000;
const textExtension = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|html|css|js|jsx|ts|tsx|py|go|rs|java|c|h|cpp|yaml|yml|toml|ini|sh|sql|svg)$/i;
async function imageValue(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) throw new Error("Use PNG, JPEG, WebP, GIF, or BMP images.");
  if (file.size > 25_000_000) throw new Error("Images must be under 25 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d"); if (!context) throw new Error("Image previews are unavailable in this browser.");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.65, 0.45, 0.25]) { const value = canvas.toDataURL("image/jpeg", quality); if (value.length <= 200_000) return value; }
    const smaller = document.createElement("canvas"); smaller.width = Math.max(1, Math.round(canvas.width / 2)); smaller.height = Math.max(1, Math.round(canvas.height / 2));
    smaller.getContext("2d")!.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    const value = smaller.toDataURL("image/jpeg", 0.6); if (value.length <= 200_000) return value;
    throw new Error("Image is too detailed. Try a smaller crop.");
  } finally { bitmap.close(); }
}
export async function readComposerFile(file: File): Promise<ComposerAttachment> {
  let kind: ComposerAttachment["kind"], value: string;
  if (file.type.startsWith("image/") && file.type !== "image/svg+xml") { kind = "image"; value = await imageValue(file); }
  else {
    if (!(file.type.startsWith("text/") || /^(application\/(json|xml|javascript))$/.test(file.type) || textExtension.test(file.name))) throw new Error("This file type isn't supported. Attach an image or a text/code file.");
    if (file.size > 64_000) throw new Error("Text files must be under 64 KB.");
    const bytes = await file.arrayBuffer();
    try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("Text files must use UTF-8 encoding."); }
    if (/[\x00-\x08\x0e-\x1f]/.test(value)) throw new Error("This file contains binary data; attach a text file instead.");
    kind = "text"; value = `${file.name}\n${value}`;
  }
  return { id: crypto.randomUUID(), kind, value, name: file.name || "Pasted image" };
}
export function useComposerAttachments({ attachments, onChange, disabled = false, worker = false }: { attachments: ComposerAttachment[]; onChange: (update: (previous: ComposerAttachment[]) => ComposerAttachment[]) => void; disabled?: boolean; worker?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const addFiles = async (files: FileList | File[]) => {
    if (disabled || pending.current) return;
    if (worker) { setError("Attachments are available in the main conversation. Switch back to attach a file."); return; }
    pending.current = true; setLoading(true); setError("");
    try {
      const chosen = Array.from(files);
      if (chosen.length + attachments.length > 4) throw new Error("Attach up to four files per message.");
      const added = await Promise.all(chosen.map(readComposerFile));
      if ([...attachments, ...added].reduce((sum, item) => sum + item.value.length, 0) > MAX_TOTAL) throw new Error("These attachments are too large together. Remove a file or use smaller images.");
      onChange(previous => previous.length + added.length > 4 || [...previous, ...added].reduce((sum, item) => sum + item.value.length, 0) > MAX_TOTAL ? previous : [...previous, ...added]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't read this file."); }
    finally { pending.current = false; setLoading(false); }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => { if (event.clipboardData.files.length) { event.preventDefault(); void addFiles(event.clipboardData.files); } };
  const onDrop = (event: DragEvent<HTMLElement>) => { if (event.dataTransfer.files.length) { event.preventDefault(); void addFiles(event.dataTransfer.files); } };
  const onDragOver = (event: DragEvent<HTMLElement>) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); };
  return { loading, addFiles, onPaste, onDrop, onDragOver, open: () => input.current?.click(), controls: <>
    <input ref={input} type="file" multiple hidden aria-label="Attach images or text files" disabled={disabled || loading} onChange={event => { if (event.target.files) void addFiles(event.target.files); event.target.value = ""; }} />
    {attachments.length > 0 && <div className="flex flex-wrap gap-2 px-1 pb-3">{attachments.map(item => <div key={item.id} className="relative flex max-w-48 items-center gap-2 rounded-[var(--radius-panel)] border border-border bg-muted/40 p-2">{item.kind === "image" ? <img src={item.value} alt={item.name} className="size-16 rounded-[var(--radius-control)] object-cover" /> : <Paperclip className="size-5 shrink-0" />}<span className="truncate text-xs" title={item.name}>{item.name}</span><button type="button" aria-label={`Remove ${item.name}`} className="absolute -right-1 -top-1 rounded-[var(--radius-control)] border border-border bg-background p-1" disabled={disabled} onClick={() => onChange(previous => previous.filter(file => file.id !== item.id))}><X className="size-3" /></button></div>)}</div>}
    {loading && <p role="status" className="px-1 pb-2 text-xs text-muted-foreground">Preparing attachments…</p>}
    {error && <p role="alert" className="px-1 pb-2 text-xs text-destructive">{error}</p>}
  </> };
}
