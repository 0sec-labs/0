import wordmarkInkUrl from "../../../../assets/0-aperture-ink.svg";
import wordmarkWhiteUrl from "../../../../assets/0-aperture-white.svg";
import { BrandGlyph } from "./brand-glyph";
import { cn } from "@/lib/utils";

export function BrandMark({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return <BrandGlyph className={className} />;
  }

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <img
        alt="0security"
        data-brand-variant="ink"
        src={wordmarkInkUrl}
        width={240}
        height={24}
        className="h-auto w-48 max-w-full dark:hidden"
      />
      <img
        alt="0security"
        data-brand-variant="white"
        src={wordmarkWhiteUrl}
        width={240}
        height={24}
        className="hidden h-auto w-48 max-w-full dark:block"
      />
    </div>
  );
}
