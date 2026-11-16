import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ControlCard, Feedback, SubmitButton, TextField } from "@/components/console-control/control-ui";
import { accessSummary, connectAction, connectorHeadline, deviceLine, healthNote, validConnectorToken, type ConnectorRowDto } from "@/lib/connector-model";

type Act = (v: { name: string; action: "connect" | "sign-in" | "cancel" | "disconnect"; token?: string }) => Promise<unknown>;

/** The access list the install prompt showed, so the card never says less than what was approved. */
export function ConnectorAccess({ row }: { row: ConnectorRowDto }) {
  const { reads, writes } = accessSummary(row.connector);
  return <p className="text-xs break-words text-muted-foreground-2">Reads: {reads}. Writes: {writes}.</p>;
}

/** Generic Connect card for any connector extension: headline, access, health, and ONE Connect button. */
export function ConnectorCard({ row, disabled, pending, error, act }: { row: ConnectorRowDto; disabled: boolean; pending: boolean; error: unknown; act: Act }) {
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(false);
  const action = connectAction(row);
  const note = healthNote(row.status);
  const device = deviceLine(row.status.device);
  const name = row.extension;
  const submit = () => { const value = token.trim(); setToken(""); setOpen(false); if (validConnectorToken(value)) void act({ name, action: "connect", token: value }).catch(() => undefined); };
  return <ControlCard title={row.connector.title} description={row.connector.description || undefined}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span data-connector-headline={name} className="min-w-0 text-sm font-medium break-words">{connectorHeadline(row)}</span>
      {row.connector.hosts.length > 0 && <Badge variant="outline">{row.connector.hosts[0]}</Badge>}
    </div>
    <ConnectorAccess row={row} />
    {note && <p role="status" className="text-xs text-destructive">{note}</p>}
    {device && <p role="status" className="text-sm">{device}</p>}
    {open && action.kind === "token"
      ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); submit(); }}>
        <TextField label={`${row.connector.title} token`} type="password" autoComplete="off" spellCheck={false} value={token} required maxLength={16384} disabled={pending} onChange={event => setToken(event.target.value)} hint="Checked, then stored on this computer. Scripts only receive it if the extension declared it and you approved it." />
        <div className="flex gap-2"><SubmitButton type="submit" variant="outline" pending={pending} disabled={!validConnectorToken(token) || pending}>Save</SubmitButton><Button type="button" variant="ghost" onClick={() => { setToken(""); setOpen(false); }}>Cancel</Button></div>
      </form>
      : <div className="flex flex-wrap gap-2">
        {row.status.state === "signing-in"
          ? <SubmitButton variant="outline" pending={pending} disabled={disabled || pending} onClick={() => void act({ name, action: "cancel" }).catch(() => undefined)}>Cancel</SubmitButton>
          : <SubmitButton variant="outline" pending={pending} disabled={disabled || pending || action.kind === "none"} onClick={() => { if (action.kind === "token") setOpen(true); else void act({ name, action: "sign-in" }).catch(() => undefined); }}>{action.label}</SubmitButton>}
        {row.status.state === "connected" && row.connector.methods.includes("token") && <Button variant="ghost" disabled={disabled || pending} onClick={() => void act({ name, action: "disconnect" }).catch(() => undefined)}>Disconnect</Button>}
      </div>}
    <Feedback error={error} />
  </ControlCard>;
}
