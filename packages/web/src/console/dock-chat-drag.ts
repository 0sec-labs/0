import { chatResourceKey, parseChatResourceKey } from "./chat-host";
export interface DockChatDrag { id:string; backendId:string; title:string; saved:boolean; key:string }
/** Decode a history drag without borrowing another host's bare session ID. */
export function parseDockChatDrag(value:unknown,defaultBackendId:string):DockChatDrag|undefined {
  let decoded=value;
  if(typeof value === "string") {try{decoded=JSON.parse(value);}catch{return undefined;}}
  if(!decoded || typeof decoded!=="object" || Array.isArray(decoded))return undefined;
  const input=decoded as Record<string,unknown>;
  if(typeof input.sessionId!=="string" || input.backendId!==undefined && typeof input.backendId!=="string")return undefined;
  const ref=parseChatResourceKey(input.sessionId,typeof input.backendId==="string"?input.backendId:defaultBackendId);
  if(!ref || typeof input.backendId === "string" && input.backendId!==ref.backendId)return undefined;
  return {...ref,key:chatResourceKey(ref),title:typeof input.title==="string"?input.title.replace(/[\u0000-\u001f\u007f]/g," ").slice(0,200):"Chat",saved:input.saved===true};
}
