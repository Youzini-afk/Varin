import {it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {RequestHandler} from 'express';
import {decodeManagedTerminalRef,encodeManagedTerminalRef} from '@varin/application-client';
import {authorizeManagedTerminal,registerManagedTerminalRoutes} from './managed-routes.js';
import {writeTerminalFrame} from './stream-backpressure.js';
const resourceOwner={kind:'managed_host' as const,hostId:'target',connectionId:'paired',endpointIdentity:'frozen-endpoint'};
it('managed terminal requests retain the exact target and trusted local principal, with no retry of uncertain input',async()=>{
  const routes=new Map<string,RequestHandler>(),commands:unknown[]=[];
  const terminal=vi.fn(async(input:{sessionId:string;command:{action:string}})=>{
    commands.push(input);if(input.command.action==='write')throw new Error('Target write outcome is unknown');
    return {sessionId:input.sessionId,cwd:'/target',cols:80,rows:24,status:'running'};
  });
  const source=vi.fn(async()=>({terminal}));let principal='alice';
  registerManagedTerminalRoutes({post:(name:string,...handlers:RequestHandler[])=>routes.set(name,handlers.at(-1)!)} as never,
    {requireAuth:(_req,_res,next)=>next(),coordinatorHostId:'coordinator',authorize:async()=>principal,source:source as never});
  const run=async(body:unknown)=>{const response={statusCode:200,headersSent:false,body:undefined as unknown,
    json(value:unknown){this.body=value;return this;},status(value:number){this.statusCode=value;return this;}};
    await routes.get('/api/terminal/managed')!({body} as never,response as never,()=>{});return response;};
  const selection={mode:'native_workspace',workspaceId:'workspace',executionWorkspaceId:'execution',branchId:'branch',adoptionOperationId:'adopt'};
  const created=await run({action:'create',options:{resourceOwner,cwd:'/target',selection,sessionId:'ui-tab',shell:'sh',spawn:{executable:'forged'}}});
  expect(commands[0]).toMatchObject({command:{options:{selection}}});
  expect(created.statusCode).toBe(200);
  const sessionId=(created.body as {sessionId:string}).sessionId;
  expect(decodeManagedTerminalRef(sessionId)).toEqual({resourceOwner,sessionId:'ui-tab'});
  expect(source).toHaveBeenCalledWith(resourceOwner);
  expect(commands[0]).toMatchObject({coordinatorHostId:'coordinator',command:{action:'create',options:{cwd:'/target'}}});
  expect(JSON.stringify(commands[0])).not.toContain('forged');
  principal='bob';await run({sessionId,command:{action:'inspect'}});
  expect((commands[0] as {sessionId:string}).sessionId).not.toBe((commands[1] as {sessionId:string}).sessionId);
  const failed=await run({sessionId,command:{action:'write',data:'original command',inputId:'same-input'}});
  expect(failed.statusCode).toBe(400);expect((failed.body as {error:string}).error).toContain('unknown');expect(terminal).toHaveBeenCalledTimes(3);
  expect(encodeManagedTerminalRef({resourceOwner:{...resourceOwner,hostId:'another-target'},sessionId:'ui-tab'})).not.toBe(sessionId);
});
it('terminal frame transport waits for drain and rejects a lost observer rather than buffering another queue',async()=>{
  const response=Object.assign(new EventEmitter(),{headersSent:false,destroyed:false,setHeader:vi.fn(),write:vi.fn(()=>false)});
  const controller=new AbortController();let settled=false;
  const first=writeTerminalFrame(response as never,{v:4,t:'output',d:'original'},controller.signal).then(()=>{settled=true;});
  await Promise.resolve();expect(settled).toBe(false);expect(response.write).toHaveBeenCalledOnce();
  response.emit('drain');await first;expect(settled).toBe(true);
  const lost=writeTerminalFrame(response as never,{v:4,t:'output',d:'next'},controller.signal);controller.abort();
  await expect(lost).rejects.toThrow('disconnected');
});

it('managed terminal authorization requires an actual auth context, original resource ownership and both client capabilities',async()=>{
  const allowed=vi.fn(async()=>true);
  await expect(authorizeManagedTerminal(null,allowed)).rejects.toThrow('authentication');
  expect(allowed).not.toHaveBeenCalled();
  await expect(authorizeManagedTerminal({type:'owner',principalId:'foreign'},async()=>false)).rejects.toThrow('resource owner');
  await expect(authorizeManagedTerminal({type:'client',principalId:'owner',client:{capabilities:['terminal:use']}},allowed)).rejects.toThrow('capability');
  await expect(authorizeManagedTerminal({type:'client',principalId:'owner',client:{capabilities:['terminal:use','process:control']}},allowed)).resolves.toBe('owner');
  await expect(authorizeManagedTerminal({type:'legacy'},allowed)).resolves.toBeNull();
});
