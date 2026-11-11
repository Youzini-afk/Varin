import {expect,it,vi} from 'vitest';
import type {ExternalConversation} from '@varin/application-client';
import {openManagedExternalTransport,closeManagedExternalTransport,type ExternalTransportReceipt} from './managed-transport.js';
import type {ManagedSourceClient,} from '../harness/managed-remote-client.js';
import type {ManagedExternalControlReceipt} from '../harness/managed-remote-types.js';
const source={resource_owner:{kind:'managed_host' as const,hostId:'target',connectionId:'original',endpointIdentity:'endpoint'},mode:'live_root' as const,
 workspace_id:'workspace',execution_workspace_id:'workspace',branch_id:null,revision:null,live_root:{hostId:'target',rootId:'root',canonicalRoot:'C:\\remote'}};
const conversation={id:'external:original',configurationId:'target-only',harness:'codex',executionSource:source,cwd:'C:\\remote'} as ExternalConversation;
function fixture(){
 let receipt:ExternalTransportReceipt={id:'first',processId:'first',conversationId:conversation.id,source,configurationId:conversation.configurationId,harness:'codex',state:'pending'};
 const commands:Record<string,unknown>[]=[];
 const command=async<T>(input:Record<string,unknown>):Promise<T>=>{commands.push(input);
  if(input.action==='inspect')return {...conversation,transport:receipt} as T;
  if(input.action==='transport_prepare'){if(receipt.state==='closed')receipt={...receipt,id:'next',processId:'next',state:'pending'};return receipt as T;}
  if(input.action==='transport_bind'){receipt={...receipt,state:'bound'};return receipt as T;}
  if(input.action==='transport_closed'){if(input.transportId!==receipt.id)throw new Error('generation changed');receipt={...receipt,state:'closed'};return receipt as T;}
  throw new Error('unknown command');};
 const process=(id='first')=>({processId:id,workspaceId:'workspace',mode:'pipe',kernelEpoch:'epoch',writerActive:true,status:'running',pid:4} as import('../kernel/protocol.generated.js').KernelProcessSnapshot);
 const client={externalControl:vi.fn(async(input:{transportId:string;stop:boolean;release?:boolean}):Promise<ManagedExternalControlReceipt>=>({conversationId:conversation.id,transportId:input.transportId,processId:input.transportId,source,accepted:false,executorStopped:input.stop||input.release===true,notStarted:input.stop||input.release===true,outputReleased:input.release===true,process:null,authorities:[]})),
  externalBinding:vi.fn(async()=>({configurationIdentity:'target-launch',configuration:{id:'target-only',name:'Target',enabled:true,harness:'codex',command:'target-program',args:[]},command:'C:\\tools\\target-program',args:[]})),
  bind:vi.fn(async()=>({authorityId:'authority',resourceEpoch:'epoch',physicalRoot:source.live_root,source})),externalSpawn:vi.fn(async(input:{processId:string})=>process(input.processId))};
 const owner={coordinatorHostId:'coordinator',source:vi.fn(async()=>client as unknown as ManagedSourceClient)};
 return{owner,client,command,commands,receipt:()=>receipt,set:(value:Partial<ExternalTransportReceipt>)=>{receipt={...receipt,...value};},process};
}
it('keeps target Source and program identity instead of interpreting a remote cwd locally',async()=>{
 const f=fixture();const opened=await openManagedExternalTransport(f.owner,conversation,f.command,()=>{},new AbortController().signal);
 expect(opened.executionCwd).toBe('C:\\remote');expect(opened.launch.command).toBe('C:\\tools\\target-program');
 expect(f.owner.source).toHaveBeenCalledWith(source.resource_owner,expect.any(AbortSignal));
 expect(f.client.bind).toHaveBeenCalledWith(expect.objectContaining({scope:{kind:'external',conversationId:conversation.id,transportId:'first'},purpose:'external_harness',operationId:'first',source:expect.objectContaining({resourceOwner:source.resource_owner,liveRoot:source.live_root,tools:[]})}),expect.any(AbortSignal));
 expect(f.client.externalSpawn).toHaveBeenCalledTimes(1);expect(f.receipt().state).toBe('bound');
});
it('retains unknown dispatch and stops its original address before native-session resume',async()=>{
 const f=fixture();f.client.externalSpawn.mockRejectedValueOnce(new Error('connection lost after dispatch'));
 await expect(openManagedExternalTransport(f.owner,conversation,f.command,()=>{},new AbortController().signal)).rejects.toThrow('connection lost');
 expect(f.receipt().state).toBe('bound');expect(f.commands.some(c=>c.action==='transport_closed')).toBe(false);
 f.client.externalControl.mockImplementation(async input=>({conversationId:conversation.id,transportId:input.transportId,processId:input.transportId,source,accepted:true,executorStopped:input.stop||input.release===true,notStarted:false,outputReleased:input.release===true,process:{...f.process(input.transportId),writerActive:!input.stop&&!input.release,treeConfirmed:input.stop||input.release===true},authorities:[]}));
 await openManagedExternalTransport(f.owner,{...conversation,sessionId:'original-native'},f.command,()=>{},new AbortController().signal);
 expect(f.commands).toContainEqual({action:'transport_closed',id:conversation.id,transportId:'first'});
 expect(f.client.externalSpawn).toHaveBeenLastCalledWith(expect.objectContaining({processId:'next',sessionId:'original-native'}));
});
it('reconciles target not-started proof after losing the coordinator close response',async()=>{
 const f=fixture();f.client.externalControl.mockImplementation(async input=>({conversationId:conversation.id,transportId:input.transportId,processId:input.transportId,source,accepted:false,executorStopped:true,notStarted:true,outputReleased:input.release===true,process:null,authorities:[]}));
 await openManagedExternalTransport(f.owner,conversation,f.command,()=>{},new AbortController().signal);
 expect(f.client.externalSpawn).toHaveBeenCalledWith(expect.objectContaining({processId:'next'}));
});
it('does not clear product responsibility on another process receipt',async()=>{
 const f=fixture();f.set({state:'bound'});f.client.externalControl.mockImplementation(async input=>({conversationId:conversation.id,transportId:input.transportId,processId:input.transportId,source,accepted:true,executorStopped:true,notStarted:false,process:{...f.process('wrong'),writerActive:false,treeConfirmed:true},authorities:[]}));
 await expect(closeManagedExternalTransport(f.owner,conversation,f.command)).rejects.toThrow('unconfirmed');expect(f.receipt().state).toBe('bound');
});
