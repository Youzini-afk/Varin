import { describe, expect, it, vi } from 'vitest';
import { createModelTextService, type ModelTextInput } from './service.js';
import type { ModelTextView, Operation } from '../kernel/protocol.generated.js';

function fixture() {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const records = new Map<string, ModelTextView>();
  const trace: string[] = [];
  let settings: unknown = { defaultProvider: 'configured', defaultModel: 'main' };
  let loseAdmission = false;
  let loseGeneration = false;
  let corruptContent = false;
  const credentialOwner = { scope: async () => ({ reference:'provider:configured',authority:'host',account:'original',generation:1 }), release: vi.fn() };
  const resolveModel = vi.fn(async (selection: {providerId: string;modelId: string}) => ({configuration:{providerId:selection.providerId,providerFamily:'openai-responses',model:selection.modelId,endpoint:'https://native.invalid/v1/responses',configurationGeneration:1,allowAnonymous:false,maxOutputTokens:8192},credentialOwner,acceptsImages:false}));
  const status = (work: ModelTextView | undefined) => {
    if (!work) return null;
    const op=work.inference;const state=op?.result?.kind==='control'?op.result.value as Record<string,unknown>:{};
    return {requestId:work.requestId,requestFingerprint:work.requestFingerprint,runId:work.runId,executionOwner:work.generation.callerOwner,
      providerId:work.generation.configuration.providerId,modelId:work.generation.configuration.model,purpose:work.generation.purpose,cancelled:work.cancelled,retryAllowed:work.retryAllowed,effect:op?.effect??'none',
      inference:op?{operationId:op.id,phase:op.phase,outcome:op.outcome,cancelRequested:op.cancel_requested,dispatched:state.dispatched,recovered:false,receipt:state.receipt??null}:null};
  };
  const kernel = {
    kernelEpoch: 'native-epoch',
    registerCredentialOwner: vi.fn(async () => { trace.push('registered'); }),
    unregisterCredentialOwner: vi.fn(() => { trace.push('released'); }),
    agentRuntimeRequest: vi.fn(async (method:string,p:Record<string,unknown>) => {
      if (method === 'runtime.model_text.status') return structuredClone(status(records.get(p.requestId as string)));
      if (method === 'runtime.model_text.read') { trace.push('read'); if(corruptContent) throw new Error('Original content is unreadable'); return structuredClone(records.get(p.requestId as string) ?? null); }
      if (method === 'runtime.model_text.admit') {
        const generation = p.generation as ModelTextView['generation'];
        const requestId = `model-text:${p.key}`;
        records.set(requestId,{requestId,requestFingerprint:p.requestFingerprint as string,runId:`${requestId}:run`,generation,cancelled:false,retryAllowed:false,inference:null});
        if (loseAdmission) { loseAdmission=false;throw new Error('Admission reply lost'); }
        return {requestId};
      }
      if (method === 'runtime.inference.generate') {
        const work=records.get(p.parentOperationId as string)!;
        work.inference={id:`inference:${work.requestId}:1`,run_id:work.runId,phase:'running',outcome:null,effect:'dispatched',cancel_requested:false,
          result:{kind:'control',value:{dispatched:true}}} as Operation;
        trace.push('generated');notify();
        if (loseGeneration) {loseGeneration=false;throw new Error('Generation reply lost');}
        return {};
      }
      if (method === 'runtime.model_text.cancel') {
        const work=records.get(p.requestId as string)!;work.cancelled=true; if(work.inference) work.inference.cancel_requested=true;trace.push('cancelled');notify();return structuredClone(status(work));
      }
      throw new Error(`Unexpected method ${method}`);
    }),
  };
  const listen=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};
  const models={resolveModel,describeModel:vi.fn(async(selection:{providerId:string;modelId:string})=>({providerId:selection.providerId,model:selection.modelId,contextWindowTokens:16000,maxOutputTokens:8192}))};
  const service=createModelTextService({kernel:kernel as unknown as Parameters<typeof createModelTextService>[0]['kernel'],runtime:{onEvent:listener=>listen(()=>listener({} as Parameters<typeof listener>[0])),onReady:listen,onExit:listener=>listen(()=>listener(new Error('Executor exited')))},models:models as unknown as Parameters<typeof createModelTextService>[0]['models'],readSettings:async()=>settings});
  const input:ModelTextInput={key:'original',purpose:'git-commit',prompt:'Describe these changes'};
  const settle=(key='original',outcome='succeeded',stopped=true)=>{
    const work=records.get(`model-text:${key}`)!;const op=work.inference!;
    op.phase='terminal';op.outcome=outcome as Operation['outcome'];op.effect=outcome==='indeterminate'?'unknown':'confirmed';
    op.result={kind:'control',value:{dispatched:true,receipt:{localExecutorStopped:stopped,providerCompleted:outcome==='succeeded',usage:{measurement:'actual',inputTokens:7,outputTokens:4}},response:{text:'Original native text',providerOutput:{finishReason:'stop'}}}};
    work.retryAllowed=outcome!=='succeeded'&&stopped;trace.push('settled');notify();
  };
  return {service,kernel,records,trace,input,settle,resolveModel,models,credentialOwner,notify,setSettings:(value:unknown)=>{settings=value;},loseReplies:()=>{loseAdmission=true;loseGeneration=true;},corruptContent:()=>{corruptContent=true;}};
}
const until = async (condition:()=>boolean) => { for(let i=0;i<100&&!condition();i++) await new Promise(resolve=>setTimeout(resolve,1)); expect(condition()).toBe(true); };

describe('native standalone text owner',()=>{
  it('selects only explicit native settings and never invents a provider fallback',async()=>{
    const f=fixture();f.setSettings({utilityModel:{providerId:'utility',modelId:'chosen'},walkthroughModel:{providerId:'review',modelId:'whole-diff'},defaultProvider:'default',defaultModel:'main'});
    expect(await f.service.describe()).toMatchObject({providerID:'utility',modelID:'chosen',source:'utility'});
    expect(await f.service.describe({purpose:'walkthrough'})).toMatchObject({providerID:'review',modelID:'whole-diff',source:'walkthrough'});
    expect(await f.service.describe({model:{providerId:'explicit',modelId:'request'}})).toMatchObject({providerID:'explicit',modelID:'request',source:'request'});
    f.setSettings({});await expect(f.service.describe()).rejects.toMatchObject({code:'model-not-configured'});
    expect(f.resolveModel).not.toHaveBeenCalled();await f.service.close();
  });
  it('deduplicates an original key and releases credentials only after reading the durable result',async()=>{
    const f=fixture();const first=f.service.generate(f.input);const second=f.service.generate({...f.input});
    expect(first).toBe(second);await until(()=>f.trace.includes('generated'));
    expect(f.kernel.unregisterCredentialOwner).not.toHaveBeenCalled();f.settle();
    expect(await first).toEqual({requestId:'model-text:original',providerId:'configured',modelId:'main',text:'Original native text'});
    expect(f.trace.indexOf('released')).toBeGreaterThan(f.trace.lastIndexOf('read'));
    expect(f.resolveModel).toHaveBeenCalledTimes(1);await f.service.close();
  });
  it('restores successful original text before consulting changed settings or credentials',async()=>{
    const f=fixture();const running=f.service.generate(f.input);await until(()=>f.trace.includes('generated'));f.settle();await running;
    f.setSettings({utilityModel:{providerId:'broken'}});f.resolveModel.mockRejectedValue(new Error('Original credential was removed'));
    expect(await f.service.generate(f.input)).toMatchObject({text:'Original native text',modelId:'main'});
    expect(f.resolveModel).toHaveBeenCalledTimes(1);
    await expect(f.service.generate({...f.input,prompt:'Different input'})).rejects.toMatchObject({code:'model-text-key-conflict'});await f.service.close();
  });
  it('recovers lost admission and generation replies without another provider request',async()=>{
    const f=fixture();f.loseReplies();const running=f.service.generate(f.input);await until(()=>f.trace.includes('generated'));f.settle();await running;
    expect(f.kernel.agentRuntimeRequest.mock.calls.filter(([method])=>method==='runtime.inference.generate')).toHaveLength(1);
    expect(f.kernel.unregisterCredentialOwner).toHaveBeenCalledOnce();await f.service.close();
  });
  it('cancellation waits for original transport drain and retains uncertain billing',async()=>{
    const f=fixture();const controller=new AbortController();const running=f.service.generate({...f.input,signal:controller.signal});
    const failed=expect(running).rejects.toMatchObject({code:'model-text-indeterminate',requestId:'model-text:original'});
    await until(()=>f.trace.includes('generated'));controller.abort();f.notify();await until(()=>f.trace.includes('cancelled'));
    expect(f.kernel.unregisterCredentialOwner).not.toHaveBeenCalled();f.settle('original','indeterminate');await failed;
    expect(await f.service.inspect('model-text:original')).toMatchObject({effect:'unknown',executorStopped:true,retryAllowed:true});
    expect(f.kernel.unregisterCredentialOwner).toHaveBeenCalledOnce();await f.service.close();
  });
  it('retains metadata and releases drained credentials even when original content is unreadable',async()=>{
    const f=fixture();const running=f.service.generate(f.input);const failure=expect(running).rejects.toMatchObject({code:'model-text-output-unavailable',requestId:'model-text:original'});
    await until(()=>f.trace.includes('generated'));f.corruptContent();f.settle();await failure;
    expect(f.kernel.unregisterCredentialOwner).toHaveBeenCalledOnce();
    expect(await f.service.inspect('model-text:original')).toMatchObject({outcome:'succeeded',executorStopped:true,outputStatus:'unavailable'});
    expect(await f.service.cancel('model-text:original')).toMatchObject({executorStopped:true});await f.service.close();
  });
  it('keeps a restored uncertain request visible and never replays it',async()=>{
    const f=fixture();const running=f.service.generate(f.input);const failed=expect(running).rejects.toMatchObject({code:'model-text-indeterminate'});
    await until(()=>f.trace.includes('generated'));f.settle('original','indeterminate',false);await failed;
    expect(f.kernel.unregisterCredentialOwner).not.toHaveBeenCalled();
    await expect(f.service.generate(f.input)).rejects.toMatchObject({code:'model-text-indeterminate'});
    expect(f.trace.filter(value=>value==='generated')).toHaveLength(1);
    const closing=f.service.close();f.kernel.kernelEpoch='next-epoch';f.notify();await closing;
  });
});
