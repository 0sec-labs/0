// Top-level sidebar entries become documentation sections: tabs in the header on
// wide screens and a switcher at the top of the sidebar otherwise. A top-level
// group is a section whose children fill the sidebar (its sub-groups render as
// headings); a top-level link is a tab of its own. Pages outside every group
// (for example a top-level Research link) show the full sidebar.
import type { StarlightRouteData } from '@astrojs/starlight/route-data';

export type SidebarEntry = StarlightRouteData['sidebar'][number];
type SidebarLink = Extract<SidebarEntry, { type: 'link' }>;

export interface DocsSection {
  label: string;
  href: string;
  isCurrent: boolean;
  external: boolean;
  entries?: SidebarEntry[];
}

const hasCurrent = (entry: SidebarEntry): boolean =>
  entry.type === 'link' ? entry.isCurrent : entry.entries.some(hasCurrent);

export const isExternal = (href: string) => /^https?:\/\//.test(href);

const firstInternalLink = (entry: SidebarEntry): SidebarLink | undefined => {
  if (entry.type === 'link') return isExternal(entry.href) ? undefined : entry;
  for (const child of entry.entries) {
    const found = firstInternalLink(child);
    if (found) return found;
  }
  return undefined;
};

export function getSections(sidebar: SidebarEntry[]) {
  const sections: DocsSection[] = sidebar.flatMap((entry): DocsSection[] => {
    if (entry.type === 'link') {
      return [{ label: entry.label, href: entry.href, isCurrent: entry.isCurrent, external: isExternal(entry.href) }];
    }
    const link = firstInternalLink(entry);
    return link ? [{ label: entry.label, href: link.href, isCurrent: hasCurrent(entry), external: false, entries: entry.entries }] : [];
  });
  const groups = sections.filter((section) => section.entries);
  const active = sections.find((section) => section.isCurrent);
  // Tabs only help when the sidebar actually splits into a few sections.
  const tabbed = groups.length > 1 && sections.length <= 5;
  const entries = tabbed && active?.entries ? active.entries : sidebar.filter((entry) => !tabbed || entry.type === 'group');
  return { sections, active, tabbed, entries };
}

export const sectionLabelFor = (sidebar: SidebarEntry[]) => getSections(sidebar).active?.label;
