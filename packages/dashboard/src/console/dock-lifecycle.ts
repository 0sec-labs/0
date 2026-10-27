/** Distinguish a live dock's user interactions from disposal/HMR removal events. */
export function createDockLifecycle<T extends object>() {
  let current:T|undefined;
  let active=false;
  const closeIntents=new Set<string>();
  return {
    activate(owner:T) {current=owner;active=true;closeIntents.clear();},
    deactivate() {active=false;closeIntents.clear();},
    accepts(owner:T,connected:boolean) {return active && current===owner && connected;},
    hasCloseIntent(owner:T) {return active && current===owner && closeIntents.size>0;},
    close(owner:T,id:string,connected:boolean,remove:()=>void) {
      if(!active || current!==owner || !connected)return;
      closeIntents.add(id);
      try {remove();} finally {closeIntents.delete(id);}
    },
    consumeClose(owner:T,id:string,connected:boolean) {
      if(!active || current!==owner || !connected)return false;
      return closeIntents.delete(id);
    },
  };
}
