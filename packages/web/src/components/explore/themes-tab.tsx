import { ThemeGallery } from "@/components/appearance/theme-gallery";

/** Explore → Themes: the same gallery as Settings → Appearance, filtered by the shared search box. */
export function ThemesTab({ query = "" }: { query?: string }) {
  return <ThemeGallery key={query} query={query} />;
}
