import { useState } from "react";
import { Monitor, Users, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function WorkspaceChoice({ teamName, initialMode = "personal", onContinue }: { teamName?: string; initialMode?: "personal" | "team"; onContinue: () => void }) {
  const [mode, setMode] = useState<"personal" | "team">(teamName ? "team" : initialMode);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const join = () => {
    try {
      const url = new URL(address.trim());
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password) throw new Error();
      url.search = ""; url.hash = "";
      window.location.assign(url.href);
    } catch { setError("Enter an HTTPS workspace address, or a localhost address for local testing."); }
  };
  if (teamName) return <div className="space-y-4"><p className="text-sm text-muted-foreground">Signed in to {teamName}.</p><Button onClick={onContinue}>Continue<ArrowRight className="size-4" /></Button></div>;
  return <div className="space-y-5">
    <div role="group" aria-label="Workspace type" className="grid gap-3 sm:grid-cols-2">
      {([{ id: "personal", title: "Personal", description: "Your workspace. No account needed.", icon: Monitor }, { id: "team", title: "Team", description: "Shared chats, findings, and workflows.", icon: Users }] as const).map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => { setMode(item.id); setError(""); }} className={cn("space-y-2 rounded-2xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary", mode === item.id ? "border-primary bg-muted/50" : "border-border hover:bg-muted/30")}><item.icon className="size-5" /><span className="block text-sm font-medium">{item.title}</span><span className="block text-xs text-muted-foreground">{item.description}</span></button>)}
    </div>
    {mode === "personal" ? <Button onClick={onContinue}>Continue without an account<ArrowRight className="size-4" /></Button>
      : <form className="space-y-3" onSubmit={event => { event.preventDefault(); join(); }}><label className="block space-y-2 text-sm"><span>Workspace address</span><Input type="url" placeholder="https://security.example.com" autoComplete="url" required value={address} onChange={event => { setAddress(event.target.value); setError(""); }} aria-invalid={Boolean(error)} /></label><p className="text-xs text-muted-foreground">Use the address from your team. Sign in there to join.</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="submit">Open team workspace<ArrowRight className="size-4" /></Button></form>}
  </div>;
}
