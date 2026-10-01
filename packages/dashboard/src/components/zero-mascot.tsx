import curiousUrl from "@/assets/zero-curious.webp";
import planningUrl from "@/assets/zero-planning.webp";
import connectUrl from "@/assets/zero-connect.webp";
import { cn } from "@/lib/utils";

const scenes = {
  findings: { src: curiousUrl, width: 640, height: 640 },
  workflows: { src: planningUrl, width: 256, height: 256 },
  plugins: { src: connectUrl, width: 366, height: 332 },
};

/** Existing transparent Zero poses from the canonical 0cloud artwork library. */
export function ZeroMascot({ scene, compact = false }: { scene: keyof typeof scenes; compact?: boolean }) {
  const artwork = scenes[scene];
  return <div aria-hidden="true" className={cn("shrink-0", compact ? "hidden h-16 w-20 sm:block" : "size-28")}>
    <img src={artwork.src} alt="" width={artwork.width} height={artwork.height} className="h-full w-full object-contain" />
  </div>;
}
