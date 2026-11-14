import { useMemo, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { TableSpec } from "./types";

export default function TableView({ spec, expanded }: { spec: TableSpec; expanded?: boolean }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>();
  const rows = useMemo(() => {
    if (!sort) return spec.rows;
    return [...spec.rows].sort((a, b) => {
      const x = a[sort.key] ?? "";
      const y = b[sort.key] ?? "";
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir;
    });
  }, [spec, sort]);
  return (
    <div className={expanded ? "overflow-auto" : "max-h-[28rem] overflow-auto"}>
      <Table>
        <TableHeader>
          <TableRow>
            {spec.columns.map((column) => {
              const state = sort?.key === column.key ? (sort.dir === 1 ? "ascending" : "descending") : "none";
              return (
                <TableHead key={column.key} aria-sort={state} className={column.align === "right" ? "text-right" : column.align === "center" ? "text-center" : undefined}>
                  <button type="button" className="inline-flex items-center gap-1 rounded-sm font-semibold outline-none focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => setSort((cur) => (cur?.key === column.key ? (cur.dir === 1 ? { key: column.key, dir: -1 } : undefined) : { key: column.key, dir: 1 }))}>
                    {column.label}
                    <span aria-hidden="true" className="text-muted-foreground">{state === "ascending" ? "↑" : state === "descending" ? "↓" : ""}</span>
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {spec.columns.map((column) => (
                <TableCell key={column.key} className={column.align === "right" ? "text-right tabular-nums" : column.align === "center" ? "text-center" : undefined}>
                  {row[column.key] === null ? "" : String(row[column.key])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No rows.</p>}
    </div>
  );
}
