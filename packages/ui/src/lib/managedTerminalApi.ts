import {runtimeFetch,decodeManagedTerminalRef,consumeManagedTerminalFrames,type CreateTerminalOptions,type ManagedTerminalCommand,type TerminalSession,type TerminalHandlers,type TerminalStreamEvent} from '@varin/application-client';
export const isManagedTerminal=(id:string)=>decodeManagedTerminalRef(id)!==null;
const post=async(body:unknown):Promise<TerminalSession>=>{
  const response=await runtimeFetch('/api/terminal/managed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok){const data=await response.json().catch(()=>null);throw new Error(data?.error??'Original target terminal result is unconfirmed');}
  return response.json() as Promise<TerminalSession>;
};
export const createManagedTerminal=(options:CreateTerminalOptions)=>post({action:'create',options});
export const managedTerminalCommand=(sessionId:string,command:ManagedTerminalCommand)=>post({sessionId,command});
const subscriptions=new Set<AbortController>();
export function disposeManagedTerminalSubscriptions():void{for(const controller of subscriptions)controller.abort();subscriptions.clear();}
export function subscribeManagedTerminal(sessionId:string,onEvent:TerminalHandlers['onEvent'],onError?:TerminalHandlers['onError']):()=>void{
  const controller=new AbortController();subscriptions.add(controller);let attempt=0,sequence=-1;
  const run=async()=>{while(!controller.signal.aborted){
    try{
      const response=await runtimeFetch('/api/terminal/managed/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId}),signal:controller.signal});
      await consumeManagedTerminalFrames(response,frame=>{
        const q=typeof frame.q==='number'?frame.q:undefined;
        if(frame.t==='snapshot'){
          sequence=q??0;attempt=0;
          onEvent({type:'snapshot',sequence,data:typeof frame.history==='string'?frame.history:'',status:frame.status as TerminalStreamEvent['status'],exitCode:typeof frame.exitCode==='number'?frame.exitCode:undefined,signal:typeof frame.signal==='number'?frame.signal:null,ptyBackend:typeof frame.ptyBackend==='string'?frame.ptyBackend:undefined});
        }else if(q!==undefined&&q>sequence){
          sequence=q;
          if(frame.t==='output')onEvent({type:'data',sequence:q,data:typeof frame.d==='string'?frame.d:'',replayData:typeof frame.r==='string'?frame.r:undefined});
          else if(frame.t==='exit')onEvent({type:'exit',sequence:q,exitCode:typeof frame.exitCode==='number'?frame.exitCode:undefined,signal:typeof frame.signal==='number'?frame.signal:null});
          else if(frame.t==='error'||frame.t==='unavailable')onError?.(new Error(String(frame.message??'Target terminal observation is unavailable')),false);
        }
      },controller.signal);
      if(!controller.signal.aborted)throw new Error('Target terminal stream disconnected');
    }catch(error){
      if(controller.signal.aborted)return;
      onError?.(error instanceof Error?error:new Error(String(error)),false);
      onEvent({type:'reconnecting',attempt:++attempt});
      await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,1000);controller.signal.addEventListener('abort',finish,{once:true});});
    }
  }};
  void run().finally(()=>subscriptions.delete(controller));return()=>{controller.abort();subscriptions.delete(controller);};
}
