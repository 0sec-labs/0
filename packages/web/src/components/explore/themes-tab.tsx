import { CapyAppearanceIcon } from "@/ui/icons/capy";
import { EmptyState } from "@/components/state-panel";

/** Placeholder for the Themes tab of Explore. Replace this component with the gallery; the page only renders `<ThemesTab query={...} />`. */
export function ThemesTab({ query: _query }: { query?: string }) {
  return <EmptyState variant="inline" icon={<CapyAppearanceIcon aria-hidden="true" className="size-6" />} title="Themes are coming soon" body="Palettes for light and dark will be browsable here. Appearance settings still work in Settings." />;
}
