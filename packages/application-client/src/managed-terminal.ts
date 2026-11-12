import type { SourceResourceOwner } from '@varin/protocol';
import type { CreateTerminalOptions, TerminalSession } from './types.js';
export interface ManagedTerminalRef {resourceOwner:Extract<SourceResourceOwner,{kind:'managed_host'}>;sessionId:string}
export type ManagedTerminalCommand =
  | {action:'create';options:CreateTerminalOptions}
  | {action:'write';data:string;inputId:string}
  | {action:'resize';cols:number;rows:number}
  | {action:'appearance';themeMode?:'dark'|'light';terminalBackground?:string;terminalForeground?:string}
  | {action:'stop'|'close';force?:boolean}
  | {action:'inspect'};
export interface ManagedTerminalRequest {coordinatorHostId:string;sessionId:string;command:ManagedTerminalCommand}
export type ManagedTerminalResult=TerminalSession & {cwd:string};
export const encodeManagedTerminalRef=(reference:ManagedTerminalRef):string=>'managed-terminal:'+encodeURIComponent(JSON.stringify(reference));
export function decodeManagedTerminalRef(value:string):ManagedTerminalRef|null {
  if(!value.startsWith('managed-terminal:'))return null;
  const parsed=JSON.parse(decodeURIComponent(value.slice('managed-terminal:'.length))) as ManagedTerminalRef;
  const owner=parsed?.resourceOwner;
  if(!parsed.sessionId||typeof parsed.sessionId!=='string'||owner?.kind!=='managed_host'||![owner.hostId,owner.connectionId,owner.endpointIdentity].every(value=>typeof value==='string'&&value.length>0))throw new Error('Managed terminal identity is invalid');
  return parsed;
}
export async function consumeManagedTerminalFrames(response:Response,emit:(frame:Record<string,unknown>)=>void|Promise<void>,signal:AbortSignal):Promise<void>{
  if(!response.ok)throw Object.assign(new Error((await response.text())||'Original terminal stream is unavailable'),{status:response.status});
  if(!response.body)throw new Error('Terminal stream has no body');
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
  try{for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;
    pending+=decoder.decode(next.value,{stream:true});let at:number;
    while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(!line)continue;
      const frame=JSON.parse(line) as Record<string,unknown>;if(frame.v!==4||typeof frame.t!=='string')throw new Error('Original terminal protocol changed');await emit(frame);
    }
  }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
