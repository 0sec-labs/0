import { useNavigate } from "react-router-dom";
import { agentThreadHref } from "@/lib/agent-create-model";
import { setNewAgentOpen, useNewAgentOpen } from "@/lib/new-agent";
import { CreateSentinelDialog } from "./create-sentinel-dialog";

/** Mounted once in the app shell. Creating a sentinel lands the owner in that sentinel's own thread. */
export function NewAgentHost() {
  const open = useNewAgentOpen();
  const navigate = useNavigate();
  return <CreateSentinelDialog open={open} onOpenChange={setNewAgentOpen} onCreated={sentinel => { setNewAgentOpen(false); navigate(agentThreadHref(sentinel.id)); }} />;
}
