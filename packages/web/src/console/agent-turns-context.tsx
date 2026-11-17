import { createContext, useContext } from "react";
import type { AgentTurn } from "@/sentinels/model";

/** The Agent's turns by the first 8 characters of their id (the nonce in each trigger turn's header). Provided by the Agent page; other threads have none. */
export const AgentTurnsContext = createContext<ReadonlyMap<string, AgentTurn> | null>(null);
export const useAgentTurnsByNonce = () => useContext(AgentTurnsContext);
