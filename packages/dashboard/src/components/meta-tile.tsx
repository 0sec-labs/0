import { CardListItem } from "@/components/ui/card";

export function MetaTile({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <CardListItem className="px-0 py-3 first:pt-0 last:pb-0">
      <div className="text-sm text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-sm text-foreground ${mono ? "break-all tabular-nums" : ""}`}>{value}</div>
    </CardListItem>
  );
}
