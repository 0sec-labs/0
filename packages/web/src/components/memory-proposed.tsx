import { CapyDatabaseIcon } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Cell, Tile } from "@/components/skills/cells";
import { proposalDetail, type MemoryNote } from "@/memory-model";

/** Notes 0 wants to keep after reading outside content. They are not used until a person accepts them. */
export function MemoryProposed({ notes, readOnly, pending, onAccept, onEdit, onReject }: {
  notes: readonly MemoryNote[]; readOnly: boolean; pending: boolean;
  onAccept: (note: MemoryNote) => void; onEdit: (note: MemoryNote) => void; onReject: (note: MemoryNote) => void;
}) {
  if (notes.length === 0) return null;
  return <section aria-labelledby="memory-proposed" className="mt-4">
    <h2 id="memory-proposed" className="text-sm font-medium">Proposed</h2>
    <p className="mt-0.5 text-sm text-muted-foreground">0 read web pages, files or tool output before suggesting these. They are not used until you accept them.</p>
    <ul className="mt-2 divide-y-[0.5px] divide-[var(--card-hairline)]">{notes.map(note => <Cell key={note.id} to="#" tile={<Tile icon={<CapyDatabaseIcon className="size-4" />} />} name={note.text} description={proposalDetail(note)}
      interactive={false} trailing={readOnly ? undefined : <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => onAccept(note)}>Accept</Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => onEdit(note)}>Edit</Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => onReject(note)}>Reject</Button></div>} />)}</ul>
  </section>;
}
