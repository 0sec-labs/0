import { Button } from "@/components/ui/button";
import { Cell, SkillMarkIcon, Tile } from "@/components/skills/cells";
import { CapyPuzzleIcon } from "@/ui/icons/capy";
import type { ExtensionItem } from "@/lib/extensions-list";

/** Built-in extensions carry the 0 mark (GitHub is one); everything installed is a puzzle piece. */
export function ExtensionTile({ builtin }: { builtin: boolean }) {
  return builtin ? <Tile icon={<SkillMarkIcon className="size-6" />} /> : <Tile icon={<CapyPuzzleIcon aria-hidden="true" className="size-4 text-muted-foreground-1" />} />;
}

const TONE = { muted: "text-muted-foreground-2", warning: "text-warning", danger: "text-destructive" } as const;

/** One extension row: tile, name, one sentence, and its status on the right with Connect or Review when there is something to do. */
export function ExtensionCell({ item, disabled, onOpen, onAction }: { item: ExtensionItem; disabled: boolean; onOpen: () => void; onAction: () => void }) {
  const { status } = item;
  return <Cell to={`/extensions?extension=${encodeURIComponent(item.name)}`} onOpen={onOpen} tile={<ExtensionTile builtin={item.row.builtin} />} name={item.title} description={item.sentence}
    trailing={<span className="flex items-center gap-2.5">
      <span data-extension-status={item.name} className={`text-sm whitespace-nowrap ${TONE[status.tone]}`}>{status.label}</span>
      {status.action && <Button size="sm" variant="outline" disabled={disabled} onClick={onAction}>{status.action === "review" ? "Review" : "Connect"}</Button>}
    </span>} />;
}
