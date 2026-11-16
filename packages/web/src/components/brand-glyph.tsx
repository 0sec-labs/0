import { cn } from "@/lib/utils";

/** The compact 0security mark. Kept free of file imports so tests that bundle with esbuild can load it. */
export function BrandGlyph({ className }: { className?: string }) {
  return (
    <svg
      data-brand-mark="compact"
      role="img"
      aria-label="0security"
      viewBox="-2 -2 24 24"
      className={cn("size-9 text-[#403D39] dark:text-[#FCFAF6]", className)}
    >
      <path fill="var(--brand-orange, #FD802E)" d="M12.5 2 H17.5 L7.5 18 H2.5 Z" />
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M4 0 H16 L20 4 V16 L16 20 H4 L0 16 V4 Z M4 5 V15 L5 16 H15 L16 15 V5 L15 4 H5 Z"
      />
    </svg>
  );
}
