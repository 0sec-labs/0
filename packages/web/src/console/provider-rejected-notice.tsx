import { useState } from "react";
import { Link } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import type { ConsoleMessageInput, ConsoleSessionSnapshot } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { useProviders } from "@/components/console-control/connections-control";
import { useModelCatalog } from "@/console/use-model-catalog";
import { rememberModelChoice } from "@/lib/last-model-choice";
import { configureChatRuntime } from "./model-source";
import { rejectedBanner } from "./provider-health";

/** A 401/403 on a turn: name the provider and model, offer a one-click switch to a healthy model and a link to the exact connection. */
export function ProviderRejectedNotice({ snapshot, message, canSwitch, onRetry }: {
  snapshot: ConsoleSessionSnapshot;
  message: { text: string; attachments?: ConsoleMessageInput["attachments"] };
  canSwitch: boolean;
  onRetry?: (message: { text: string; attachments?: ConsoleMessageInput["attachments"] }) => void;
}) {
  const api = useBackendApi();
  const providers = useProviders();
  const catalog = useModelCatalog({ backendId: api.client.backendId, webFetchJson: api.webFetchJson });
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  const banner = rejectedBanner({ runtime: snapshot.runtime, providers: providers.data?.providers ?? [], models: catalog.data?.models ?? [], recommended: catalog.data?.recommended });
  const back = encodeURIComponent(`/chats/${snapshot.session.id}`);
  const to = `/connections?${banner.providerId ? `provider=${encodeURIComponent(banner.providerId)}&` : ""}session=${snapshot.session.id}&return=${back}`;
  const switchModel = async () => {
    if (!banner.next || !onRetry) return;
    setSwitching(true); setFailed(false);
    try {
      await configureChatRuntime(api, snapshot.session.id, { providerId: banner.next.providerId, model: banner.next.model }, snapshot.runtime);
      rememberModelChoice(api.client.backendId, { providerId: banner.next.providerId, model: banner.next.model });
      onRetry(message);
    } catch { setFailed(true); } finally { setSwitching(false); }
  };
  return <>
    <span className="basis-full">{banner.headline} Update the key, or use a model that works.</span>
    {canSwitch && banner.next && onRetry && <Button type="button" variant="outline" size="sm" className="w-fit gap-1.5" disabled={switching} onClick={() => void switchModel()}>
      <RotateCcw aria-hidden="true" className="size-3.5" />{switching ? "Switching…" : `Switch to ${banner.next.model}`}
    </Button>}
    <Button variant="outline" size="sm" className="w-fit" render={<Link to={to} />}>Manage connection</Button>
    {failed && <span className="basis-full text-muted-foreground-2">Couldn't switch models. Try again or pick one from the model menu.</span>}
  </>;
}
