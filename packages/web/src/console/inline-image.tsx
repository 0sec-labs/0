import { useState } from "react";
import { ImageOff, Maximize2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/** Raster-only data and same-origin assets; remote images require an explicit click. */
export function imageSource(value: string): string | undefined {
  if (!value.trim()) return undefined;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value) && value.length <= 8_000_000) return value;
  try {
    const url = new URL(value, window.location.origin);
    if ((url.protocol === "https:" || url.origin === window.location.origin) && !url.username && !url.password) return url.href;
  } catch { /* Keep unsupported local paths as captions. */ }
  return undefined;
}

export function InlineImage({ src, alt = "Screenshot" }: { src: string; alt?: string }) {
  const safe = imageSource(src);
  const [failed, setFailed] = useState(false);
  const [loadRemote, setLoadRemote] = useState(false);
  const remote = safe?.startsWith("https:") && new URL(safe).origin !== window.location.origin;
  if (!safe || failed) return <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><ImageOff className="size-4" />{alt || "Image unavailable"}</span>;
  if (remote && !loadRemote) return <button type="button" onClick={() => setLoadRemote(true)} className="my-3 block rounded-[var(--radius-control)] border border-border px-4 py-3 text-sm text-muted-foreground">Load image: {alt || new URL(safe).hostname}</button>;
  return <Dialog>
    <DialogTrigger asChild><button type="button" aria-label={`Expand image: ${alt}`} className="group relative my-4 block max-w-full overflow-hidden rounded-[var(--radius-control)] bg-muted/20 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <img src={safe} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="max-h-[32rem] max-w-full object-contain" />
      <span className="absolute bottom-3 right-3 rounded-[var(--radius-control)] bg-black/60 p-2 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><Maximize2 className="size-4" /></span>
    </button></DialogTrigger>
    <DialogContent className="w-fit max-w-[95vw] sm:max-w-[95vw] p-3 pt-12"><DialogTitle className="sr-only">{alt}</DialogTitle><img src={safe} alt={alt} referrerPolicy="no-referrer" className="max-h-[82dvh] max-w-full object-contain" /></DialogContent>
  </Dialog>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function toolImages(result: unknown): Array<{ src: string; alt: string }> {
  if (typeof result === "string") { try { result = JSON.parse(result); } catch { return []; } }
  const receipt = record(result);
  const output = record(receipt.output);
  const img = record(record(receipt.meta).image);
  const images: Array<{ src: string; alt: string }> = [];
  const raster = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  if (raster.has(String(img.mimeType)) && typeof img.imageBase64 === "string") images.push({ src: `data:${img.mimeType};base64,${img.imageBase64}`, alt: typeof output.screenshot_caption === "string" ? output.screenshot_caption : "Browser screenshot" });
  // MCP tools may return image blocks directly or inside the executor's output envelope.
  for (const content of [receipt.content, output.content]) {
    for (const value of Array.isArray(content) ? content : []) {
      const block = record(value);
      if (block.type === "image" && typeof block.data === "string" && raster.has(String(block.mimeType))) images.push({ src: `data:${block.mimeType};base64,${block.data}`, alt: "Tool screenshot" });
    }
  }
  const seen = new Set<string>();
  return images.filter(image => { if (!imageSource(image.src) || seen.has(image.src)) return false; seen.add(image.src); return true; }).slice(0, 8);
}

/** Browser captures belong to the browser workspace; generated assets stay in chat. */
export function transcriptToolImages(name: string, result: unknown): Array<{ src: string; alt: string }> {
  return /browser|playwright|puppeteer|computer|cua|screenshot/i.test(name) ? [] : toolImages(result);
}
