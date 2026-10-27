export type ChatHostReadiness="connecting"|"ready"|"unregistered"|"failed";
/** A cached failure or descriptor is not a completed handshake for a newly opened pane. */
export function chatHostReadiness({registryReady,registered,fetchedAfterMount,fetching,hasData,hasError}: {
  registryReady:boolean;registered:boolean;fetchedAfterMount:boolean;fetching:boolean;hasData:boolean;hasError:boolean;
}):ChatHostReadiness {
  if(!registryReady)return "connecting";
  if(!registered)return "unregistered";
  if(!fetchedAfterMount)return "connecting";
  // Background reconnects keep the validated pane and its draft mounted.
  if(hasData)return "ready";
  if(fetching)return "connecting";
  return hasError?"failed":"connecting";
}
/** Route updates must never mount a new conversation against the previous host's API. */
export function descriptorForRoute<T extends {id:string}>(backendId:string,selected:T|null):T|null {
  return selected?.id===backendId?selected:null;
}
