import express from 'express';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createThreadsHttpAPI, configureRuntimeUrlResolver, setRuntimeExtraHeaders } from '@varin/application-client';
import { createModelAuthority } from './model-authority.js';
import { createKernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
// Load the credential owner's source through a runtime fixture boundary; Host compilation owns only Host sources.
const { HostCredentialAuthority } = await import(pathToFileURL(path.join(repository, 'packages/pi-host/src/credential-authority.ts')).href);
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release/varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as {version: string}).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { setRuntimeExtraHeaders(null); configureRuntimeUrlResolver({apiBaseUrl:'',realtimeBaseUrl:''}); for(const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server) {
 server.listen(0,'127.0.0.1'); await once(server,'listening'); const address=server.address();
 if(!address || typeof address==='string') throw new Error('missing listener');
 cleanups.push(async()=>{server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));});
 return `http://127.0.0.1:${address.port}`;
}
it.each([false,true])('Anthropic subscription=%s dispatch preserves its bearer, beta, and request-body contract',async(subscription)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-wif-review-'));cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
 const assertion=[Buffer.from('{"alg":"RS256"}').toString('base64url'),Buffer.from(JSON.stringify({iss:'https://fixture.example.test',sub:'fixture-workload',aud:'fixture-api',exp:2000000000})).toString('base64url'),'fake-signature'].join('.');
 const token=subscription?'sk-ant-oat-fake-subscription-token':'fake-anthropic-federated-access-token';const captured:Array<{path:string;headers:IncomingHttpHeaders;body:Record<string,unknown>}>=[];
 const base=await listen(createServer((request,response)=>{const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
  captured.push({path:request.url!,headers:request.headers,body:JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>});
  if(request.url==='/v1/oauth/token'){response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({access_token:token,token_type:'Bearer',expires_in:3600}));return;}
  response.writeHead(200,{'content-type':'text/event-stream'});const events=[
   {type:'message_start',message:{id:'fixture-msg',type:'message',role:'assistant',content:[],model:'claude-fixture',usage:{input_tokens:5,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Actual federated answer.'}},
   {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:6}},{type:'message_stop'},
  ];response.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 });}));
 const file=path.join(root,'assertion.jwt');await fs.writeFile(file,assertion);
 const agentDir=path.join(root,'agent');const authority=HostCredentialAuthority.open(agentDir);
 await authority.modifyWithIntent('anthropic','replace',async()=>subscription?{type:'oauth',access:token,refresh:'fake-subscription-refresh',expires:2000000000000}:{type:'api_key',env:{ANTHROPIC_IDENTITY_TOKEN_FILE:file,ANTHROPIC_ORGANIZATION_ID:'fixture-org',ANTHROPIC_FEDERATION_RULE_ID:'fixture-rule',ANTHROPIC_WORKSPACE_ID:'fixture-workspace'}});
 await fs.writeFile(path.join(agentDir,'models.json'),JSON.stringify({providers:{anthropic:{baseUrl:base,headers:{'anthropic-beta':'fixture-feature'},models:[{id:'claude-fixture',name:'Fixture',api:'anthropic-messages',maxTokens:128}]}}}));
 const kernel=createKernelClient({hostId:'wif-review',storageRoot:path.join(root,'kernel'),buildVersion,kernelPath,allowCargoDevRunner:false});cleanups.push(()=>kernel.close());
 const errors:unknown[]=[];const adapter=new ThreadAdapter(new AgentRuntimeClient(kernel),createModelAuthority(authority),async()=>{throw new Error('no source');},(_id,error)=>errors.push(error));
 const app=express();registerCommonRequestMiddleware(app,{express});registerThreadRoutes(app,adapter,(_req,_res,next)=>next());const host=await listen(createServer(app));configureRuntimeUrlResolver({apiBaseUrl:host,realtimeBaseUrl:host});
 const api=createThreadsHttpAPI();const identity=await api.create('federated-thread');const receipt=await api.submit({...identity,key:'federated-input',expectedHead:null,text:'Exercise federation using fake credentials.',model:{providerId:'anthropic',modelId:'claude-fixture'}});
 await expect.poll(async()=>(await api.run(receipt.run_id)).state,{timeout:10_000}).toBe('completed');
 expect(captured.map(value=>value.path)).toEqual(subscription?['/v1/messages']:['/v1/oauth/token','/v1/messages']);
 if(!subscription) expect(captured[0]!.body.assertion).toBe(assertion);
 const sent=captured.at(-1)!;expect(sent.headers.authorization).toBe(`Bearer ${token}`);
 expect(sent.headers['x-api-key']).toBeUndefined();expect(sent.headers['anthropic-beta']).toContain('fixture-feature');
 if(subscription){expect(sent.headers['x-app']).toBe('cli');expect(JSON.stringify(sent.body.system)).toContain("You are Claude Code, Anthropic's official CLI for Claude.");}
 else {expect(sent.headers['anthropic-beta']).toContain('oauth-2025-04-20');expect(JSON.stringify(sent.body.system)).not.toContain('Claude Code');}
 const snapshot=await api.snapshot(identity);expect(JSON.stringify(snapshot.history)).toContain('Actual federated answer.');
 const state=JSON.stringify({snapshot,events:await api.events(0),run:await api.run(receipt.run_id)});for(const secret of [token,assertion]) expect(state).not.toContain(secret);
 const disk=await fs.readFile(path.join(agentDir,'auth.json'),'utf8');if(!subscription) expect(disk).not.toContain(token);expect(disk).not.toContain(assertion);
 expect(errors).toEqual([]);
},30_000);
