import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Feedback, SubmitButton, TextField } from "@/components/console-control/control-ui";
import { connectAction, deviceLine, validConnectorToken, type ConnectorRowDto } from "@/lib/connector-model";

export type ConnectorAct = (v: { name: string; action: "connect" | "sign-in" | "cancel" | "disconnect"; token?: string }) => Promise<unknown>;

/** Connect any connector extension other than GitHub: a token field or one sign-in button, and its errors inside the dialog only. */
export function ConnectorDialog({ row, pending, error, act, onClose }: { row: ConnectorRowDto | null; pending: boolean; error: unknown; act: ConnectorAct; onClose: () => void }) {
  const [token, setToken] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => { setToken(""); setTouched(false); }, [row?.extension]);
  const state = row?.status.state;
  useEffect(() => { if (touched && state === "connected") onClose(); }, [touched, state, onClose]);
  if (!row) return null;
  const name = row.extension;
  const action = connectAction(row);
  const device = deviceLine(row.status.device);
  const run = (v: Parameters<ConnectorAct>[0]) => { setTouched(true); void act(v).catch(() => undefined); };
  return <Dialog open onOpenChange={next => { if (!next && !pending) onClose(); }}>
    <DialogContent showCloseButton={false} className="sm:max-w-md rounded-md">
      <DialogHeader><DialogTitle>Connect {row.connector.title}</DialogTitle>{row.connector.description && <DialogDescription>{row.connector.description}</DialogDescription>}</DialogHeader>
      {action.kind === "token" && <form id="connector-token-form" onSubmit={event => { event.preventDefault(); const value = token.trim(); setToken(""); if (validConnectorToken(value)) run({ name, action: "connect", token: value }); }}>
        <TextField label={`${row.connector.title} token`} type="password" autoComplete="off" spellCheck={false} value={token} required maxLength={16384} disabled={pending} onChange={event => setToken(event.target.value)} hint="Checked, then stored on this computer." />
      </form>}
      {device && <p role="status" className="text-sm">{device}</p>}
      {touched && <Feedback error={error} />}
      <DialogFooter>
        <Button variant="ghost" disabled={pending} onClick={() => { if (state === "signing-in") run({ name, action: "cancel" }); else onClose(); }}>{state === "signing-in" ? "Stop signing in" : "Cancel"}</Button>
        {action.kind === "token" && <SubmitButton type="submit" form="connector-token-form" pending={pending} disabled={!validConnectorToken(token) || pending}>Connect</SubmitButton>}
        {action.kind === "sign-in" && state !== "signing-in" && <SubmitButton pending={pending} disabled={pending} onClick={() => run({ name, action: "sign-in" })}>Continue</SubmitButton>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
