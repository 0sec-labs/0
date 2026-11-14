import { EmptyState, LoadingState } from "@/components/state-panel";
import { useId, type ComponentProps, type ReactNode } from "react";
import { CheckCircle2, LoaderCircle, RefreshCcw } from "lucide-react";
import { CapyAlertIcon as AlertCircle } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { CONNECTIONS_HREF, errorText, isModelDisabledError } from "@/lib/api-error";


export function ControlCard({ title, description, children, className }: { title?: string; description?: string; children: ReactNode; className?: string }) {
  return <section className="control-section flex min-w-0 flex-col gap-4">{title && <div className="flex flex-col gap-1.5"><h2 className="text-base leading-[1.2] font-medium text-foreground">{title}</h2>{description && <p className="text-sm font-normal text-muted-foreground-2">{description}</p>}</div>}<div className={cn("-mx-4 min-w-0 space-y-4 rounded-[var(--radius-card,8px)] border-[0.5px] border-[var(--card-hairline)] bg-card p-4", className)}>{children}</div></section>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-2 text-sm"><span className="font-medium">{label}</span>{children}{hint && <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>}</label>;
}

export function TextField({ label, hint, id: suppliedId, "aria-describedby": describedBy, ...props }: ComponentProps<typeof Input> & { label: string; hint?: string }) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const hintId = hint ? `${id}-hint` : undefined;
  const descriptionIds = [describedBy, hintId].filter(Boolean).join(" ") || undefined;
  return <div className="grid min-w-0 gap-2 text-sm"><label htmlFor={id} className="font-medium">{label}</label><Input {...props} id={id} aria-describedby={descriptionIds} />{hint && <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}</div>;
}

export function Check({ children, checked, onChange, disabled }: { children: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className={cn("flex items-start gap-3 rounded-md bg-muted/30 p-3 text-sm leading-relaxed", disabled && "opacity-60")}><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} className="mt-1 size-4 shrink-0 accent-primary" /><span className="min-w-0 flex-1 break-words">{children}</span></label>;
}

export function Feedback({ error, message }: { error?: unknown; message?: string | null }) {
  if (error) return <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 flex-1 break-words">{errorText(error)}{isModelDisabledError(error) && <> <Link to={CONNECTIONS_HREF} className="underline underline-offset-2">Open Connections</Link></>}</span></div>;
  if (message) return <div role="status" className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 p-3 text-sm"><CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary-text" /><span className="min-w-0 flex-1 break-words">{message}</span></div>;
  return null;
}

export function QueryState({ pending, error, retry, label = "Loading settings…" }: { pending: boolean; error: unknown; retry: () => unknown; label?: string }) {
  if (error) return <div className="space-y-3"><Feedback error={error} /><Button variant="outline" onClick={() => void retry()}><RefreshCcw className="size-4" />Try again</Button></div>;
  if (pending) return <LoadingState label={label} variant="form" />;
  return null;
}

export function SubmitButton({ pending, children, ...props }: ComponentProps<typeof Button> & { pending?: boolean }) {
  return <Button {...props} aria-busy={pending || props["aria-busy"]} disabled={pending || props.disabled}>{pending && <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />}{children}</Button>;
}

export function Facts({ entries }: { entries: [string, ReactNode][] }) {
  return <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">{entries.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm">{value ?? "Not available"}</dd></div>)}</dl>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <EmptyState variant="inline" title={children} />;
}

export function jsonBody(input: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(input) };
}

export function consoleReturn(search: string): string {
  const params = new URLSearchParams(search);
  const requested = params.get("return");
  if (requested && /^\/console(?:\/[a-zA-Z0-9_-]+)?(?:\?[^#]*)?$/.test(requested)) return requested;
  const session = params.get("session");
  return session ? `/chats/${encodeURIComponent(session)}` : "/chats";
}
