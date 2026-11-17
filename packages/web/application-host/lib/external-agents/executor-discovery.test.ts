import {expect,it,vi} from 'vitest';
import {CODEX_PERMISSION_PROFILE_OPTION,type ExternalAgentSettings,type ExternalExecutorInspection} from '@varin/application-client';
import type {SourceResourceOwner} from '@varin/protocol';
import type {AgentRuntimeClient} from '../kernel/agent-runtime-client.js';
import type {Run} from '../kernel/protocol.generated.js';
import {ResourceBridge,type PrivateResourceResponse} from '../kernel/resource-bridge.js';
import {createResourceOwner,type ResourceQuery} from '../kernel/resource-owner.js';
import {executorChoices,inspectExecutors} from './executor-discovery.js';

it('reads current configured identities, keeps Host references stable and withholds private launch metadata from model discovery',async()=>{
  const owner={kind:'local' as const};
  const settings:ExternalAgentSettings={revision:1,defaultAgent:null,agents:[{id:'codex',name:'Code work',harness:'codex',enabled:true,availability:'auto',command:'/private/program',args:['--private-setting'],defaults:{thinking:'high'}}]};
  const inspect:ExternalExecutorInspection={configurationId:'codex',name:'Code work',harness:'codex',availability:'auto',installation:{status:'installed',checkedAt:1},defaults:{thinking:'high'},authentication:'unknown',connection:'not_connected',capabilitySource:'unknown'};
  inspect.capabilities={resume:true,images:true,steering:true,models:[],configOptions:[
    {id:CODEX_PERMISSION_PROFILE_OPTION,name:'Permissions',type:'select',options:[{value:':danger-full-access',name:'Full access'}]},
  ]};
  const service={settings:vi.fn(async()=>settings),inspectExecutor:vi.fn(async()=>inspect)};
  const query={action:'list',host:'host:local',hosts:[{ref:'host:local'}],includeVarin:true,resourceOwner:owner};
  const listed=await inspectExecutors(service,query,new AbortController().signal);
  expect(listed.executors).toHaveLength(2);
  expect(JSON.stringify(listed)).not.toContain('/private/program');
  expect(JSON.stringify(listed)).not.toContain('--private-setting');
  expect(JSON.stringify(listed)).not.toContain(CODEX_PERMISSION_PROFILE_OPTION);
  const reference=executorChoices(settings,owner)[0]!.reference;
  settings.agents[0]!.command='/updated/program';settings.agents[0]!.name='Renamed';
  expect(executorChoices(settings,owner)[0]!.reference).toBe(reference);
  const resolved=await inspectExecutors(service,{action:'resolve',executor:reference,resourceOwner:owner},new AbortController().signal);
  expect(resolved.choice).toMatchObject({reference,binding:{launch:{command:'/updated/program'}}});
  settings.agents.push({id:'second',name:'New configured executor',harness:'codex',enabled:true,command:'codex',args:[]});
  expect((await inspectExecutors(service,query,new AbortController().signal)).executors).toHaveLength(3);
  const remote={kind:'managed_host' as const,hostId:'remote',connectionId:'paired',endpointIdentity:'paired-endpoint'};
  expect(executorChoices(settings,remote)[0]!.reference).not.toBe(reference);
});

it('keeps configuration probe failures generic instead of returning paths, commands or credentials',async()=>{
  const settings:ExternalAgentSettings={revision:1,defaultAgent:null,agents:[{id:'custom',name:'Custom',harness:'acp',enabled:true,command:'/secret/path',args:[]}]};
  const service={settings:vi.fn(async()=>settings),inspectExecutor:vi.fn(async()=>{throw new Error('token=secret /secret/path');})};
  const result=await inspectExecutors(service,{action:'list',resourceOwner:{kind:'local'},host:'host:local'},new AbortController().signal);
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(result.executors?.[0]).toMatchObject({installation:{status:'unknown'},authentication:'unknown'});
});

it.each<SourceResourceOwner>([{kind:'local'},{kind:'managed_host',hostId:'remote',connectionId:'paired',endpointIdentity:'paired-endpoint'}])(
  'routes private executor queries through original invocation authority to the $kind source owner',async resourceOwner=>{
  const settings:ExternalAgentSettings={revision:1,defaultAgent:null,agents:[{id:'configured',name:'Configured executor',harness:'codex',enabled:true,command:'/private/program',args:[]}]};
  const inspection:ExternalExecutorInspection={configurationId:'configured',name:'Configured executor',harness:'codex',availability:'enabled',installation:{status:'installed',checkedAt:1},defaults:{},authentication:'unknown',connection:'not_connected',capabilitySource:'unknown'};
  const service={settings:vi.fn(async()=>settings),inspectExecutor:vi.fn(async()=>inspection)};
  const run:Run={id:'run',thread_id:'thread',branch_id:'branch',state:'runnable',revision:1,epoch:1,waiting_on:null,configuration:{},cancel_requested:false};
  const organizationInvocation=vi.fn<AgentRuntimeClient['organizationInvocation']>(async()=>run);
  const resourceSnapshot=vi.fn<AgentRuntimeClient['resourceSnapshot']>(async()=>{throw new Error('Executor discovery has no file snapshot');});
  const owner=createResourceOwner({runtime:{run:async()=>run,resourceSnapshot,organizationInvocation},resources:{} as never,
    organization:async(request,_run,signal)=>({result:await inspectExecutors(service,request.input,signal)})});
  const replies:PrivateResourceResponse[]=[];
  const bridge=new ResourceBridge(()=>'epoch',async response=>{replies.push(response);},()=>{});
  bridge.setOwner(owner);
  const query:ResourceQuery={runId:run.id,origin:{kind:'model_step',request_id:'request'},callId:'executors-call',
    request:{kind:'organization',operationId:'original-operation',action:'executors',input:{action:'inspect',executor:'configured',resourceOwner}}};
  const send=async(id:string,value:unknown)=>{
    bridge.consume({v:1,kind:'resource-request',id,kernelEpoch:'epoch',query:value});
    await vi.waitFor(()=>expect(replies.some(reply=>reply.id===id)).toBe(true));
    return replies.find(reply=>reply.id===id)!.result;
  };
  try {
    for(const action of ['list','inspect','detect','resolve']) {
      const result=await send(action,{...query,request:{...query.request,input:{action,executor:'configured',resourceOwner}}});
      expect(result).toMatchObject({status:'ready',result:action==='resolve'
        ? {choice:{binding:{configuration_id:'configured',resource_owner:resourceOwner}}}
        : {executors:[{configurationId:'configured',installation:{status:'installed'}}]}});
      expect(organizationInvocation).toHaveBeenLastCalledWith({runId:run.id,origin:query.origin,callId:query.callId,operationId:'original-operation'},expect.any(AbortSignal));
      expect(service.settings).toHaveBeenLastCalledWith(expect.any(AbortSignal),resourceOwner);
      if(action!=='resolve') {
        expect(service.inspectExecutor).toHaveBeenLastCalledWith('configured',action==='detect',expect.any(AbortSignal),resourceOwner);
        expect(JSON.stringify(result)).not.toContain('/private/program');
      }
    }
    expect(resourceSnapshot).not.toHaveBeenCalled();
    organizationInvocation.mockRejectedValueOnce(new Error('Original invocation changed'));
    expect(await send('denied',query)).toMatchObject({status:'denied',reason:'Original invocation changed'});
    expect(service.settings).toHaveBeenCalledTimes(4);
    expect(service.inspectExecutor).toHaveBeenCalledTimes(3);
    for(const [id,invalid] of [
      ['unknown-action',{...query,request:{...query.request,action:'unknown'}}],
      ['source-injection',{...query,source:{resourceOwner}}],
      ['source-free-file',{...query,request:{kind:'skill',resourceId:'private-file'}}],
    ] as const) expect(await send(id,invalid)).toMatchObject({status:'invalid'});
    expect(organizationInvocation).toHaveBeenCalledTimes(5);
  } finally {bridge.close();}
});
