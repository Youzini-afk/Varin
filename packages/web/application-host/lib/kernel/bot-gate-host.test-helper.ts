/** Original KernelClient/Storage/BotService over the existing Rust↔Host stdio fixture. */
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { KernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelHandshakeResult } from './protocol.generated.js';
import { createBotService } from '../bots/bot-service.js';
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let sequence=0, kernel:KernelClient, bots:ReturnType<typeof createBotService>, botId='', storageRoot='';
let releaseStop: (()=>void) | undefined;
function bindEpoch(epoch:string) {
  const delivery=kernel as unknown as { epoch:string; started:boolean; transportFailed:boolean; handshakeResult:KernelHandshakeResult };
  delivery.epoch=epoch;delivery.started=true;delivery.transportFailed=false;
  delivery.handshakeResult={hostId:'web-domain-host',storageRoot,kernelEpoch:epoch} as KernelHandshakeResult;
}
async function waitState(state:string) {
  for(let i=0;i<3000;i++){if((await bots.get(botId))?.activity?.state===state)return;await delay(5);}
  throw new Error(`Bot did not reach ${state}`);
}
async function handle(frame:Record<string,unknown>) {
  if(frame.kind==='fixture-response') { const p=pending.get(String(frame.id));assert(p);pending.delete(String(frame.id));if(frame.ok)p.resolve(frame.result);else p.reject(new Error(String(frame.error)));return; }
  if(frame.kind==='fixture-initialize') {
    storageRoot=String(frame.storageRoot);
    kernel=new KernelClient({hostId:'web-domain-host',hostGeneration:'web-domain-generation',storageRoot,buildVersion:'0.9.25'});
    bindEpoch(String(frame.epoch));
    Object.defineProperty(kernel,'requestRaw',{value:(method:string,params:unknown,options:{grant?:{grantId:string}}={})=>{
      const id=`bot-gate:${++sequence}`;const result=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
      send({kind:'fixture-request',id,method,params,...(options.grant?{grantId:options.grant.grantId}:{})});return result;
    }});
    Object.defineProperty(kernel,'write',{value:async(value:unknown)=>{send(value);}});
    bots=createBotService({client:kernel,hostId:'web-domain-host',dataDir:String(frame.root),
      registry:{listRuns:async()=>[],listWorkspaceThreadSnapshots:async()=>[],listWorkspaceRunSessionIds:async()=>[]},
      createSession:async()=>{throw new Error('Entry session not requested');},openSession:async()=>{throw new Error('Entry session not requested');},
      publishExecutionGate:gate=>kernel.agentRuntimeRequest<void,'runtime.bot.gate.publish'>('runtime.bot.gate.publish',gate),
      lifecycle:()=>({planWork:async()=>[],planMachines:async()=>[],stop:async()=>{},stopScope:async()=>new Promise<void>(resolve=>{releaseStop=resolve;send({kind:'fixture-stop-entered'});}),machine:async(_bot,machine)=>machine,prepareWake:async()=>{},resume:async()=>{},awakened:async()=>{}}),
    });
    const bot=await bots.create({name:'Original Bot'});botId=bot.id;
    await bots.publishExecutionGates();send({kind:'fixture-prepared',bot});return;
  }
  if(frame.kind==='fixture-sleep'){await bots.sleep(botId);return;}
  if(frame.kind==='fixture-release-stop'){assert(releaseStop);releaseStop();await waitState('asleep');send({kind:'fixture-asleep',bot:await bots.get(botId)});return;}
  if(frame.kind==='fixture-wake'){await bots.wake(botId);await waitState('awake');send({kind:'fixture-awake',bot:await bots.get(botId)});return;}
  if(frame.kind==='fixture-reset-epoch') {
    (kernel as unknown as {failAll(error:Error,terminate:boolean):void}).failAll(new Error('Original kernel epoch ended'),false);
    bindEpoch(String(frame.epoch));await bots.publishExecutionGates();send({kind:'fixture-republished',bot:await bots.get(botId)});return;
  }
  if(frame.kind==='fixture-preparation-drain') {
    const runtime=new AgentRuntimeClient(kernel);let finish!:()=>void;
    const original=new Promise<void>(resolve=>{finish=resolve;});
    const caller=runtime.withRunPreparation('original-preparation',undefined,async()=>original);
    kernel.cancelRunPreparation('original-preparation');await assert.rejects(caller);
    let drained=false;const drain=kernel.drainRunPreparations('original-preparation').then(()=>{drained=true;});
    await delay(10);assert.equal(drained,false);finish();await drain;assert.equal(drained,true);
    send({kind:'fixture-preparation-drained'});return;
  }
  if(frame.kind==='fixture-close'){await bots.dispose();send({kind:'fixture-closed'});return;}
  (kernel as unknown as {consumeFrame(value:unknown):void}).consumeFrame(frame);
}
createInterface({input:process.stdin}).on('line',line=>{void handle(JSON.parse(line)).catch(error=>send({kind:'fixture-failed',error:error instanceof Error?error.stack:String(error)}));});
