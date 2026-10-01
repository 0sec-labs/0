import { Plug, Search, Workflow } from "lucide-react";
import zeroMascotUrl from "@/assets/zero-peek.png";
import { cn } from "@/lib/utils";

/** Decorative page companion; the existing Zero artwork stays the source of truth. */
export function ZeroMascot({ scene, compact = false }: { scene: "findings" | "workflows" | "plugins"; compact?: boolean }) {
  const Icon = { findings: Search, workflows: Workflow, plugins: Plug }[scene];
  return <div aria-hidden="true" className={cn("relative isolate shrink-0", compact ? "hidden w-16 sm:block" : "w-24")}>
    <img src={zeroMascotUrl} alt="" width={320} height={240} className="h-auto w-full object-contain" />
    <span className={cn("absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-background text-primary ring-2 ring-background", compact ? "size-6" : "size-8")}><Icon className={compact ? "size-3.5" : "size-4"} /></span>
  </div>;
}
