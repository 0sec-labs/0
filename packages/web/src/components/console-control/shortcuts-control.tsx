import { v } from "@/lib/vocabulary";
import { Fragment } from "react";
import { Kbd } from "@/ui/components/kbd";
import { panelShortcutRows } from "@/console/panel/registry";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/components/table";

type Shortcut = { command: string; keys: readonly string[]; when: string };
const mod = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";

/** Read-only list of the keyboard shortcuts this app actually handles. */
export const shortcutGroups: readonly { label: string; shortcuts: readonly Shortcut[] }[] = [
  { label: "General", shortcuts: [
    { command: "Search anything", keys: [mod, "K"], when: "Always" },
    { command: "Search anything", keys: ["/"], when: "Not typing in a field" },
    { command: "Toggle sidebar", keys: [mod === "⌘" ? "⇧" : "Shift", mod, "S"], when: v("{Mission} workspace") },
  ] },
  { label: "Right panel", shortcuts: panelShortcutRows(mod, mod === "⌘" ? "⇧" : "Shift") },
  { label: "Composer", shortcuts: [
    { command: "Send message", keys: ["Enter"], when: "Composer focused" },
    { command: "New line", keys: ["Shift", "Enter"], when: "Composer focused" },
    { command: "Choose command, mention or plugin", keys: ["↑", "↓"], when: "Suggestions open" },
    { command: "Insert suggestion", keys: ["Tab"], when: "Suggestions open" },
    { command: "Dismiss suggestions", keys: ["Esc"], when: "Suggestions open" },
  ] },
];

const headClass = "h-8 px-0 pr-4 text-xs font-normal text-muted-foreground-1 select-none";
export function ShortcutsControl() {
  return <div className="-mx-4 min-w-0 px-4">
    <Table aria-label="Keyboard shortcuts" className="text-xs">
      <TableHeader className="[&_tr]:border-b-[0.5px] [&_tr]:border-border-1"><TableRow className="border-b-[0.5px] border-border-1 hover:bg-transparent"><TableHead className={headClass}>Command</TableHead><TableHead className={headClass}>Keybinding</TableHead><TableHead className={headClass}>When</TableHead></TableRow></TableHeader>
      <TableBody>
        {shortcutGroups.map(group => <Fragment key={group.label}>
          <TableRow className="border-0 hover:bg-transparent"><TableCell colSpan={3} className="h-8 p-0 pt-3 text-xs font-medium text-muted-foreground-2" scope="rowgroup">{group.label}<span className="ml-2 font-normal">{group.shortcuts.length}</span></TableCell></TableRow>
          {group.shortcuts.map(shortcut => <TableRow key={`${shortcut.command}-${shortcut.keys.join("+")}`} className="border-b-[0.5px] border-border-1 hover:bg-secondary">
            <TableCell className="h-[50px] px-0 pr-4 text-sm font-medium text-foreground">{shortcut.command}</TableCell>
            <TableCell className="px-0 pr-4"><span className="flex items-center gap-1"><span className="sr-only">{shortcut.keys.join(" + ")}</span>{shortcut.keys.map(key => <Kbd key={key} aria-hidden="true">{key}</Kbd>)}</span></TableCell>
            <TableCell className="px-0 pr-4 whitespace-normal text-muted-foreground-1">{shortcut.when}</TableCell>
          </TableRow>)}
        </Fragment>)}
      </TableBody>
    </Table>
  </div>;
}
