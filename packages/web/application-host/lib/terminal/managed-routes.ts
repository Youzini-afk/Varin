import {writeTerminalFrame} from './stream-backpressure.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Express,Request,RequestHandler,Response} from 'express';
import {decodeManagedTerminalRef,encodeManagedTerminalRef,parseProjectSourceSelection,type ManagedTerminalCommand,type ManagedTerminalRef} from '@varin/application-client';
import type {ManagedSourceClient} from '../harness/managed-remote-client.js';
import {parseSourceResourceOwner} from '../kernel/thread-sources.js';
/** Authentication is resolved again at the effect boundary, not inferred from middleware. */
export async function authorizeManagedTerminal(
  auth:{type:string;principalId?:string|undefined;client?:{capabilities?:readonly string[]}|null|undefined}|null|undefined,
  canUseResources:(principal:string|null)=>Promise<boolean>,
):Promise<string|null>{
  if(!auth)throw new Error('Terminal authentication is required');
  const principal=typeof auth.principalId==='string'?auth.principalId:null;
  if(!await canUseResources(principal))throw new Error('Managed terminal access requires the Host resource owner');
  if(auth.type==='client'&&!['terminal:use','process:control'].every(cap=>auth.client?.capabilities?.includes(cap)))throw new Error('Terminal capability is required');
  return principal;
}
export function registerManagedTerminalRoutes(app:Express,options:{requireAuth:RequestHandler;coordinatorHostId:string;
  authorize(request:Request,response:Response):Promise<string|null>;
  source(owner:ManagedTerminalRef['resourceOwner'],signal?:AbortSignal):Promise<ManagedSourceClient>}){
  const target=async(request:Request,response:Response)=>{
    const principal=await options.authorize(request,response),body=request.body as Record<string,unknown>;
    let ref=typeof body.sessionId==='string'?decodeManagedTerminalRef(body.sessionId):null;
    if(!ref&&body.action==='create'){
      const input=body.options as Record<string,unknown>,resourceOwner=parseSourceResourceOwner(input?.resourceOwner);
      if(resourceOwner.kind!=='managed_host')throw new Error('A managed terminal requires its actual target Host');
      ref={resourceOwner,sessionId:typeof input.sessionId==='string'&&input.sessionId?input.sessionId:randomUUID()};
    }
    if(!ref)throw new Error('Original managed terminal identity is required');
    const sessionId='terminal:'+createHash('sha256').update(JSON.stringify([principal,ref.sessionId])).digest('hex');
    return {ref,sessionId,client:await options.source(ref.resourceOwner)};
  };
  app.post('/api/terminal/managed',options.requireAuth,async(request,response)=>{
    try{
      const {ref,sessionId,client}=await target(request,response),body=request.body as Record<string,unknown>;
      let command:ManagedTerminalCommand;
      if(body.action==='create'){
        const input=body.options as Record<string,unknown>;
        command={action:'create',options:{cwd:String(input.cwd??''),sessionId,...(input.selection !== undefined ? { selection: parseProjectSourceSelection(input.selection) } : {}),cols:input.cols as number,rows:input.rows as number,
          shell:input.shell as never,loginShell:input.loginShell as boolean,themeMode:input.themeMode as never,
          terminalBackground:input.terminalBackground as string,terminalForeground:input.terminalForeground as string}};
      }else command=body.command as ManagedTerminalCommand;
      // Never abort an accepted write/stop when only its HTTP observer leaves.
      const result=await client.terminal({coordinatorHostId:options.coordinatorHostId,sessionId,command});
      if(result.sessionId!==sessionId)throw new Error('Original target terminal identity changed');
      response.json({...result,sessionId:encodeManagedTerminalRef(ref)});
    }catch(error){if(!response.headersSent)response.status(400).json({error:error instanceof Error?error.message:String(error)});}
  });
  app.post('/api/terminal/managed/stream',options.requireAuth,async(request,response)=>{
    const controller=new AbortController(),close=()=>controller.abort();response.once('close',close);
    try{
      const {sessionId,client}=await target(request,response);
      await client.terminalStream({coordinatorHostId:options.coordinatorHostId,sessionId},frame=>writeTerminalFrame(response,frame,controller.signal),controller.signal);
      if(!response.destroyed)response.end();
    }catch(error){if(!response.headersSent)response.status(503).json({error:error instanceof Error?error.message:String(error)});else if(!response.destroyed)response.end();}
    finally{response.off('close',close);}
  });
}
