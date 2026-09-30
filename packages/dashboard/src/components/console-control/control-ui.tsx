import { useId, type ComponentProps, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const selectClass = "h-10 w-full rounded-xl border border-transparent bg-muted/60 px-3 text-sm outline-none focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground/40 disabled:opacity-50";

export function ControlCard({ title, description, children, className }: { title: string; description?: string; children: ReactNode; className?: string }) {
  return <Card className={cn("control-section", className)}><CardHeader><CardTitle>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</CardHeader><CardContent className="space-y-4">{children}</CardContent></Card>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid gap-2 text-sm"><span className="font-medium">{label}</span>{children}{hint && <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>}</label>;
}

export function TextField({ label, hint, ...props }: ComponentProps<typeof Input> & { label: string; hint?: string }) {
  const id = useId();
  return <div className="grid gap-2 text-sm"><label htmlFor={id} className="font-medium">{label}</label><Input {...props} id={id} aria-describedby={hint ? `${id}-hint` : undefined} />{hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}</div>;
}

export function Check({ children, checked, onChange, disabled }: { children: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className={cn("flex items-start gap-3 rounded-xl bg-muted/30 p-3 text-sm leading-relaxed", disabled && "opacity-60")}><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} className="mt-1 size-4 shrink-0 accent-primary" /><span>{children}</span></label>;
}

export function Feedback({ error, message }: { error?: unknown; message?: string | null }) {
  if (error) return <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span className="break-words">{error instanceof Error ? error.message : String(error)}</span></div>;
  if (message) return <div role="status" className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 p-3 text-sm"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary-text" /><span>{message}</span></div>;
  return null;
}

export function QueryState({ pending, error, retry }: { pending: boolean; error: unknown; retry: () => unknown }) {
  if (error) return <div className="space-y-3"><Feedback error={error} /><Button variant="outline" onClick={() => void retry()}><RefreshCcw className="size-4" />Try again</Button></div>;
  if (pending) return <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading…</div>;
  return null;
}

export function SubmitButton({ pending, children, ...props }: ComponentProps<typeof Button> & { pending?: boolean }) {
  return <Button {...props} disabled={pending || props.disabled}>{pending && <LoaderCircle className="size-4 animate-spin" />}{children}</Button>;
}

export function Facts({ entries }: { entries: [string, ReactNode][] }) {
  return <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">{entries.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm">{value ?? "Not available"}</dd></div>)}</dl>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">{children}</div>;
}

export function jsonBody(input: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(input) };
}

export function consoleReturn(search: string): string {
  const params = new URLSearchParams(search);
  const requested = params.get("return");
  if (requested && /^\/console(?:\/[a-zA-Z0-9_-]+)?(?:\?[^#]*)?$/.test(requested)) return requested;
  const session = params.get("session");
  return session ? `/console/${encodeURIComponent(session)}` : "/console";
}
