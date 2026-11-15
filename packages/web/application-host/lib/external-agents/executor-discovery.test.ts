import {expect,it,vi} from 'vitest';
import type {ExternalAgentSettings,ExternalExecutorInspection} from '@varin/application-client';
import {executorChoices,inspectExecutors} from './executor-discovery.js';

it('reads current configured identities, keeps Host references stable and withholds private launch metadata from model discovery',async()=>{
  const owner={kind:'local' as const};
  const settings:ExternalAgentSettings={revision:1,defaultAgent:null,agents:[{id:'codex',name:'Code work',harness:'codex',enabled:true,availability:'auto',command:'/private/program',args:['--private-setting'],defaults:{thinking:'high'}}]};
  const inspect:ExternalExecutorInspection={configurationId:'codex',name:'Code work',harness:'codex',availability:'auto',installation:{status:'installed',checkedAt:1},defaults:{thinking:'high'},authentication:'unknown',connection:'not_connected',capabilitySource:'unknown'};
  const service={settings:vi.fn(async()=>settings),inspectExecutor:vi.fn(async()=>inspect)};
  const query={action:'list',host:'host:local',hosts:[{ref:'host:local'}],includeVarin:true,resourceOwner:owner};
  const listed=await inspectExecutors(service,query,new AbortController().signal);
  expect(listed.executors).toHaveLength(2);
  expect(JSON.stringify(listed)).not.toContain('/private/program');
  expect(JSON.stringify(listed)).not.toContain('--private-setting');
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
