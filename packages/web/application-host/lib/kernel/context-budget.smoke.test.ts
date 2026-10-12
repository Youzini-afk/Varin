import assert from 'node:assert/strict';
import test from 'node:test';
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
  const install=async(version:number)=>{
    const folder=path.join(root,`package-${version}`);await fs.mkdir(folder);
    await fs.writeFile(path.join(folder,'package.json'),JSON.stringify({name:'review.budget-owner',version:'1.0.0'}));
    await fs.writeFile(path.join(folder,'varin.extension.json'),JSON.stringify({schemaVersion:1,id:'review.budget-owner',version:'1.0.0',engines:{varin:'*'},
      entrypoints:{host:{file:'host.cjs',mode:'brokered',activation:['service-request']}},provides:{services:[VARIN_CONTEXT_BUDGET_SERVICE]}}));
    await fs.writeFile(path.join(folder,'host.cjs'),`let descriptions=0;module.exports={activate(context){context.services.provide(${JSON.stringify(VARIN_CONTEXT_BUDGET_SERVICE)},{
      describe(){descriptions++;return {identity:{name:'budget',version:'${version}'},configuration:{version:${version}}}},
      decide([input]){return {kind:'compact',throughId:input.candidates[0].throughId,mode:'background',summaryInstructions:'v${version}:describe-'+descriptions}}
    })}}`);
    const installed=await runtime.installOrStage({expectedRevision:(await runtime.state()).catalog.revision,source:{kind:'local',display:'budget owner',specifier:folder}});
    return installed;
  };
  const route=async(scope:{sessionId?:string;projectId?:string})=>runtime.upsertServiceRoutingRule({expectedRevision:(await runtime.routing.read()).document.revision,
    rule:{serviceId:'varin.context.budget',version:1,providerKey:'review.budget-owner:host:varin.context.budget@1',scope,allowFallback:false}});
  return {runtime,install,route,budget:createContextBudget(runtime),close:async()=>{await runtime.stop();await fs.rm(root,{recursive:true,force:true});}};
}
test('an installed-only budget stays cold; scoped selection uses the actual broker and reuses its declaration',async()=>{
  const f=await fixture();
  try {
    await f.install(1);
    assert.equal(await f.budget.selected({sessionId:'main'},signal()),false);
    assert.equal((await f.runtime.state()).services.providers.length,0);
    await f.route({sessionId:'main'});
    assert.equal(await f.budget.selected({sessionId:'child'},signal()),false);
    const result=await f.budget.decide({sessionId:'main'},input,signal());
    assert.equal(result?.decision.kind,'compact');
    assert.equal(result?.strategy.kind,'extension');
    const second=await f.budget.decide({sessionId:'main'},input,signal());
    assert.equal(second?.decision.kind==='compact' && second.decision.summaryInstructions,'v1:describe-1');
    // An unrelated route invalidates selection facts, not the selected immutable declaration.
    await f.route({projectId:'unrelated'});
    const third=await f.budget.decide({sessionId:'main'},input,signal());
    assert.equal(third?.decision.kind==='compact' && third.decision.summaryInstructions,'v1:describe-1');
  } finally {await f.close();}
});
test('withdrawal during an unfinished decision rejects late output from the captured pin',async()=>{
  const f=await fixture();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  try {
    await f.install(1);await f.route({sessionId:'main'});
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
    const pending=f.budget.decide({sessionId:'main'},input,signal());
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
    await f.install(1);await f.route({sessionId:'main'});
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
    const pending=f.budget.decide({sessionId:'main'},input,signal());
    await ready;
    const staged=await f.install(2);
    await f.runtime.applyPackageCandidate({extensionId:'review.budget-owner',
      candidateIntegrity:staged.extensions[0]!.candidate!.integrity,expectedRevision:staged.revision});
    release();
    const original=await pending;
    assert.equal(original?.decision.kind==='compact' && original.decision.summaryInstructions,'v1:describe-1');
    assert.equal(original?.strategy.version,'1');
    const next=await f.budget.decide({sessionId:'main'},input,signal());
    assert.equal(next?.decision.kind==='compact' && next.decision.summaryInstructions,'v2:describe-1');
    assert.equal(next?.strategy.version,'2');
    assert.notDeepEqual(next?.strategy,original?.strategy);
  } finally {release();await f.close();}
});
