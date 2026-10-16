import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { VARIN_CONTEXT_BUDGET_SERVICE, type VarinContextBudgetInput } from '@varin/extension-contract';
import { createContextBudget } from './context-budget.js';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
const input:VarinContextBudgetInput={boundary:'before_model_dispatch',requestId:'request',estimate:{estimatedTokens:400,unmeasuredMedia:1,unmeasuredProviderItems:1,method:'fixture'},
  capacityTokens:500,inputBudgetTokens:450,settings:{reserveTokens:50,keepRecentTokens:100,backgroundPreparation:true,preparationWaterline:0.7},
  candidates:[{throughId:'first',prefixEstimatedTokens:300,retainedEstimatedTokens:100}]};
const signal=()=>new AbortController().signal;
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'varin-budget-owner-'));
  const runtime=await ApplicationExtensionRuntime.create({dataDir:path.join(root,'extensions'),varinVersion:'0.9.25',
    brokerScript:path.join(repository,'packages/extension-host/broker/broker-child.mjs')});
  await runtime.start();
  const preparedProviders:string[]=[]; const releasedProviders:string[]=[]; const preparedCompositions:Array<string|undefined>=[];
  const prepare=runtime.prepareService.bind(runtime);
  runtime.prepareService=async(...args)=>{
    const binding=await prepare(...args); preparedProviders.push(binding.providerId); preparedCompositions.push(binding.composition?.root);
    let released=false;
    return {...binding,release(){binding.release();if(!released){released=true;releasedProviders.push(binding.providerId);}}};
  };
  const install=async(version:number)=>{
    const folder=path.join(root,`package-${version}`);await fs.mkdir(folder);
    await fs.writeFile(path.join(folder,'package.json'),JSON.stringify({name:'review.budget-owner',version:'1.0.0'}));
    await fs.writeFile(path.join(folder,'varin.extension.json'),JSON.stringify({schemaVersion:1,id:'review.budget-owner',version:'1.0.0',engines:{varin:'*'},
      entrypoints:{host:{file:'host.cjs',mode:'brokered',activation:['service-request']}},provides:{services:[VARIN_CONTEXT_BUDGET_SERVICE]}}));
    await fs.writeFile(path.join(folder,'host.cjs'),`let descriptions=0;module.exports={activate(context){
      const configuration=structuredClone(context.storage.snapshot.document.data.configuration ?? {version:${version}});
      context.services.provide(${JSON.stringify(VARIN_CONTEXT_BUDGET_SERVICE)},{
      describe(){descriptions++;return {identity:{name:'budget',version:'${version}'},configuration}},
      decide([input]){return {kind:'compact',throughId:input.candidates[0].throughId,mode:'background',summaryInstructions:'v${version}:describe-'+descriptions+(configuration.label ? ':config-'+configuration.label : '')}}
    })}}`);
    const installed=await runtime.installOrStage({expectedRevision:(await runtime.state()).catalog.revision,source:{kind:'local',display:'budget owner',specifier:folder}});
    return installed;
  };
  const route=async(scope:{threadId?:string;projectId?:string})=>runtime.upsertServiceRoutingRule({expectedRevision:(await runtime.routing.read()).document.revision,
    rule:{serviceId:'varin.context.budget',version:1,providerKeys: ['review.budget-owner:host:varin.context.budget@1'],scope,allowFallback:false}});
  return {runtime,install,route,preparedProviders,releasedProviders,preparedCompositions,budget:createContextBudget(runtime),close:async()=>{await runtime.stop();await fs.rm(root,{recursive:true,force:true});}};
}
test('an installed-only budget stays cold; scoped selection uses the actual broker and reuses its declaration',async()=>{
  const f=await fixture();
  let retained:Awaited<ReturnType<typeof f.runtime.prepareService>>|undefined;
  try {
    await f.install(1);
    assert.equal(await f.budget.selected({threadId:'main'},signal()),false);
    assert.equal((await f.runtime.state()).services.providers.length,0);
    await f.route({threadId:'main'});
    assert.equal(await f.budget.selected({threadId:'child'},signal()),false);
    // Another actual consumer owns this generation; the budget itself retains no idle lease.
    retained=await f.runtime.prepareService({serviceId:'varin.context.budget',version:1,method:'describe',args:[],
      routing:{userId:'default',threadId:'main'}});
    const result=await f.budget.decide({threadId:'main'},input,signal());
    assert.equal(result?.decision.kind,'compact');
    assert.equal(result?.strategy.kind,'extension');
    assert.equal(result?.decision.kind==='compact' && result.decision.summaryInstructions,'v1:describe-1');
    assert.deepEqual(f.releasedProviders,f.preparedProviders.slice(1),'The actual decision releases its preparation binding');
    const second=await f.budget.decide({threadId:'main'},input,signal());
    assert.equal(second?.decision.kind==='compact' && second.decision.summaryInstructions,'v1:describe-1',
      'The same actual generation reuses its frozen description');
    assert.deepEqual(second?.strategy,result?.strategy);
    assert.equal(f.preparedProviders[2],f.preparedProviders[1],'Repeated decisions use the retained generation');
    assert.deepEqual(f.releasedProviders,f.preparedProviders.slice(1));
    // An unrelated route invalidates selection facts, not the selected immutable declaration.
    await f.route({projectId:'unrelated'});
    const third=await f.budget.decide({threadId:'main'},input,signal());
    assert.equal(third?.decision.kind==='compact' && third.decision.summaryInstructions,'v1:describe-1');
    assert.deepEqual(third?.strategy,result?.strategy);
    assert.equal(f.preparedProviders[3],retained.providerId);
    retained.release();retained=undefined;
    assert.deepEqual(f.releasedProviders,f.preparedProviders);
    await f.runtime.upsertServiceRoutingRule({expectedRevision:(await f.runtime.routing.read()).document.revision,
      rule:{serviceId:'varin.context.budget',version:1,providerKeys:[],scope:{threadId:'main'},allowFallback:true}});
    assert.equal(await f.budget.selected({threadId:'main'},signal()),true,'An explicit empty single selection is not absence');
    await assert.rejects(f.budget.decide({threadId:'main'},input,signal()),/requires exactly one provider/);
    await f.runtime.removeServiceRoutingRule({expectedRevision:(await f.runtime.routing.read()).document.revision,
      serviceId:'varin.context.budget',version:1,scope:{threadId:'main'}});
    assert.equal(await f.budget.selected({threadId:'main'},signal()),false);

  } finally {retained?.release();await f.close();}
});
test('a new worker rereads the budget configuration after storage CAS without changing its artifact or composition',async()=>{
  const f=await fixture();
  const address={extensionId:'review.budget-owner',key:'state',scope:'application' as const};
  const configurationIdentity=(label:string)=>createHash('sha256').update(JSON.stringify({label})).digest('hex');
  try {
    await f.install(1);await f.route({threadId:'main'});
    const initial=await f.runtime.storage.read(address);
    await f.runtime.storage.update(address,initial.document.revision,1,{configuration:{label:'alpha'}});
    const first=await f.budget.decide({threadId:'main'},input,signal());
    assert.equal(first?.decision.kind==='compact' && first.decision.summaryInstructions,'v1:describe-1:config-alpha');
    assert.ok(first?.strategy.kind==='extension');
    assert.equal(first.strategy.configurationIdentity,configurationIdentity('alpha'));
    assert.deepEqual(f.releasedProviders,f.preparedProviders);
    const stored=await f.runtime.storage.read(address);
    await f.runtime.storage.update(address,stored.document.revision,1,{configuration:{label:'beta'}});
    const second=await f.budget.decide({threadId:'main'},input,signal());
    assert.notEqual(f.preparedProviders[1],f.preparedProviders[0]);
    assert.equal(f.preparedCompositions[1],f.preparedCompositions[0]);
    assert.ok(second?.strategy.kind==='extension');
    assert.equal(second.strategy.artifactIntegrity,first.strategy.artifactIntegrity);
    assert.equal(second?.decision.kind==='compact' && second.decision.summaryInstructions?.endsWith(':config-beta'),true);
    assert.equal(second.strategy.configurationIdentity,configurationIdentity('beta'));
    assert.equal(second?.decision.kind==='compact' && second.decision.summaryInstructions,'v1:describe-1:config-beta');
    assert.deepEqual(f.releasedProviders,f.preparedProviders);
  } finally {await f.close();}
});
test('withdrawal during an unfinished decision rejects late output from the captured pin',async()=>{
  const f=await fixture();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  try {
    await f.install(1);await f.route({threadId:'main'});
    const prepare=f.runtime.prepareService.bind(f.runtime);
    f.runtime.prepareService=async(...args)=>{
      const binding=await prepare(...args);
      return {...binding,pin:()=>{
        const pin=binding.pin();
        return {...pin,invoke:async(method,args,signal,invocation)=>{
          const result=await pin.invoke(method,args,signal,invocation);
          if(method==='decide'){entered();await gate;}
          return result;
        }};
      }};
    };
    const pending=f.budget.decide({threadId:'main'},input,signal());
    const rejected=assert.rejects(pending);
    await ready;
    await f.runtime.setEnabled('review.budget-owner',false,(await f.runtime.state()).catalog.revision);
    release();await rejected;
  } finally {release();await f.close();}
});
test('ordinary replacement preserves the captured decision and selects the new recipe next time',async()=>{
  const f=await fixture();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  try {
    await f.install(1);await f.route({threadId:'main'});
    const prepare=f.runtime.prepareService.bind(f.runtime);
    f.runtime.prepareService=async(...args)=>{
      const binding=await prepare(...args);
      return {...binding,pin:()=>{
        const pin=binding.pin();
        return {...pin,invoke:async(method,args,signal,invocation)=>{
          const result=await pin.invoke(method,args,signal,invocation);
          if(method==='decide'){entered();await gate;}
          return result;
        }};
      }};
    };
    const pending=f.budget.decide({threadId:'main'},input,signal());
    await ready;
    const staged=await f.install(2);
    await f.runtime.applyPackageCandidate({extensionId:'review.budget-owner',
      candidateIntegrity:staged.extensions[0]!.candidate!.integrity,expectedRevision:staged.revision});
    release();
    const original=await pending;
    assert.equal(original?.decision.kind==='compact' && original.decision.summaryInstructions,'v1:describe-1');
    assert.equal(original?.strategy.version,'1');
    const next=await f.budget.decide({threadId:'main'},input,signal());
    assert.equal(next?.decision.kind==='compact' && next.decision.summaryInstructions,'v2:describe-1');
    assert.equal(next?.strategy.version,'2');
    assert.notDeepEqual(next?.strategy,original?.strategy);
  } finally {release();await f.close();}
});
