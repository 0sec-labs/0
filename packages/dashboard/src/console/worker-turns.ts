import type { ConsoleSessionSnapshot, ConsoleWorker } from "@0/shared";
import type { ReducedTurn } from "./transcript";

function timestamp(value:unknown):number|undefined {
  const parsed=typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed>0 ? parsed : undefined;
}
function resultWorkerIds(value:unknown, known:Set<string>, depth=0):Set<string> {
  const result=new Set<string>();
  if(depth>10 || value==null) return result;
  if(typeof value === "string") {
    if(known.has(value)) result.add(value);
    try { for(const id of resultWorkerIds(JSON.parse(value),known,depth+1)) result.add(id); } catch { /* Tool receipts may contain prose. */ }
  } else if(Array.isArray(value)) for(const child of value) for(const id of resultWorkerIds(child,known,depth+1)) result.add(id);
  else if(typeof value === "object") for(const child of Object.values(value)) for(const id of resultWorkerIds(child,known,depth+1)) result.add(id);
  return result;
}
/** Anchor worker activity to its launch turn, never to the most recent reply. */
export function workersForTurn(snapshot:Pick<ConsoleSessionSnapshot,"workers"|"events">,turns:ReducedTurn[]):Map<string,ConsoleWorker[]> {
  const groups=new Map<string,ConsoleWorker[]>(turns.map(turn=>[turn.id,[]]));
  if(!turns.length) return groups;
  const known=new Set(snapshot.workers.map(worker=>worker.id));
  const anchors=new Map<string,string>();
  // Spawn receipts are stronger than timestamps: a child can run across many root turns.
  for(const turn of turns) for(const tool of turn.toolCalls) {
    if(!/(?:spawn|delegate|launch).*agent|agent.*(?:spawn|delegate|launch)|spawn.*worker/i.test(tool.name)) continue;
    for(const id of resultWorkerIds(tool.result,known)) if(!anchors.has(id)) anchors.set(id,turn.id);
  }
  const byTime=(time:number|undefined) => {
    if(time===undefined) return undefined;
    let match:ReducedTurn|undefined;
    for(const turn of turns) { const start=timestamp(turn.startedAt);if(start!==undefined && start<=time)match=turn; }
    return match?.id;
  };
  const firstEvents=new Map<string,(typeof snapshot.events)[number]>();
  for(const event of snapshot.events) if(event.type === "worker") {
    const first=firstEvents.get(event.worker.id);
    if(!first || event.sequence<first.sequence) firstEvents.set(event.worker.id,event);
  }
  const launchTime=(worker:ConsoleWorker) => timestamp(worker.telemetry?.createdAt) ?? timestamp(worker.telemetry?.startedAt) ?? timestamp(worker.transcript[0]?.ts);
  const resolve=(worker:ConsoleWorker,visited=new Set<string>()):string|undefined => {
    if(anchors.has(worker.id))return anchors.get(worker.id);
    if(visited.has(worker.id))return undefined;
    visited.add(worker.id);
    // A first worker publication may be delayed; an earlier transcript/creation time wins.
    const event=firstEvents.get(worker.id);
    const created=launchTime(worker);
    const published=timestamp(event?.occurredAt);
    const time=created!==undefined && published!==undefined ? Math.min(created,published) : created ?? published;
    let anchor=byTime(time);
    if(!anchor && event) {
      for(const turn of turns) if(turn.user.sequence>0 && turn.user.sequence<=event.sequence) anchor=turn.id;
    }
    if(!anchor) {
      const parent=snapshot.workers.find(item=>item.id===worker.parentId);
      if(parent)anchor=resolve(parent,visited);
    }
    // Legacy snapshots without any launch metadata stay at the oldest visible turn.
    // This deterministic fallback cannot move old completed agents into a new live tree.
    anchor??=turns[0]?.id;
    if(anchor)anchors.set(worker.id,anchor);
    return anchor;
  };
  for(const worker of snapshot.workers) { const turnId=resolve(worker);if(turnId)groups.get(turnId)?.push(worker); }
  return groups;
}
