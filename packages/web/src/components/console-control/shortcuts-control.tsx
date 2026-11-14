import { Fragment, useState } from "react";
import { v } from "@/lib/vocabulary";
import { Kbd } from "@/ui/components/kbd";
import { Input } from "@/components/ui/input";
import { SHORTCUTS, SHORTCUT_GROUPS, bindingKeys, shortcutMatchesQuery, type Shortcut } from "@/lib/shortcuts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/components/table";

const headClass = "h-8 px-0 pr-4 text-xs font-normal text-muted-foreground-1 select-none";

function Keys({ shortcut }: { shortcut: Shortcut }) {
  return <span className="flex flex-wrap items-center gap-x-2 gap-y-1">{shortcut.bindings.map((binding, index) => {
    const keys = bindingKeys(binding);
    return <span key={keys.join("+")} className="flex items-center gap-1">
      {index > 0 && <span className="text-xs text-muted-foreground-2">or</span>}
      <span className="sr-only">{keys.join(" + ")}</span>
      {keys.map(key => <Kbd key={key} aria-hidden="true">{key}</Kbd>)}
    </span>;
  })}</span>;
}

/** Searchable, grouped list rendered from the shortcut registry the global handlers use. */
export function ShortcutList() {
  const [query, setQuery] = useState("");
  const groups = SHORTCUT_GROUPS.map(label => ({ label, shortcuts: SHORTCUTS.filter(item => item.group === label && shortcutMatchesQuery(item, query)) })).filter(group => group.shortcuts.length > 0);
  return <div className="min-w-0">
    <Input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search shortcuts" aria-label="Search shortcuts" className="mb-2" />
    <Table aria-label="Keyboard shortcuts" className="text-xs">
      <TableHeader className="[&_tr]:border-b-[0.5px] [&_tr]:border-border-1"><TableRow className="border-b-[0.5px] border-border-1 hover:bg-transparent"><TableHead className={headClass}>Command</TableHead><TableHead className={headClass}>Keybinding</TableHead><TableHead className={headClass}>When</TableHead></TableRow></TableHeader>
      <TableBody>
        {groups.length === 0 && <TableRow className="border-0 hover:bg-transparent"><TableCell colSpan={3} className="h-16 p-0 text-sm text-muted-foreground-1">No shortcuts match "{query}".</TableCell></TableRow>}
        {groups.map(group => <Fragment key={group.label}>
          <TableRow className="border-0 hover:bg-transparent"><TableCell colSpan={3} className="h-8 p-0 pt-3 text-xs font-medium text-muted-foreground-2" scope="rowgroup">{group.label}<span className="ml-2 font-normal">{group.shortcuts.length}</span></TableCell></TableRow>
          {group.shortcuts.map(shortcut => <TableRow key={shortcut.id} className="border-b-[0.5px] border-border-1 hover:bg-secondary">
            <TableCell className="h-[50px] px-0 pr-4 text-sm font-medium text-foreground">{shortcut.action}</TableCell>
            <TableCell className="px-0 pr-4"><Keys shortcut={shortcut} /></TableCell>
            <TableCell className="px-0 pr-4 whitespace-normal text-muted-foreground-1">{shortcut.scope === "mission" ? v("{Mission} workspace") : shortcut.when}</TableCell>
          </TableRow>)}
        </Fragment>)}
      </TableBody>
    </Table>
  </div>;
}

/** Read-only list of the keyboard shortcuts this app actually handles. */
export function ShortcutsControl() {
  return <div className="-mx-4 min-w-0 px-4"><ShortcutList /></div>;
}
