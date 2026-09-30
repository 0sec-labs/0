import wordmarkInkUrl from "../../../../assets/0-aperture-ink.svg";
import wordmarkWhiteUrl from "../../../../assets/0-aperture-white.svg";
import { cn } from "@/lib/utils";

export function BrandMark({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return (
      <svg
        role="img"
        aria-label="0.security"
        viewBox="-2 -2 24 24"
        className={cn("size-9 text-[#403D39] dark:text-[#FCFAF6]", className)}
      >
        <path fill="#FD802E" d="M12.5 2 H17.5 L7.5 18 H2.5 Z" />
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M4 0 H16 L20 4 V16 L16 20 H4 L0 16 V4 Z M4 5 V15 L5 16 H15 L16 15 V5 L15 4 H5 Z"
        />
      </svg>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <img
        alt="0.security"
        src={wordmarkInkUrl}
        width={240}
        height={24}
        className="h-auto w-48 max-w-full dark:hidden"
      />
      <img
        alt="0.security"
        src={wordmarkWhiteUrl}
        width={240}
        height={24}
        className="hidden h-auto w-48 max-w-full dark:block"
      />
      <div className="text-sm font-medium text-foreground">0.security operator shell</div>
    </div>
  );
}
