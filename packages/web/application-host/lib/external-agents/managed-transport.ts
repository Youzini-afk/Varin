import {resourceThreadSource} from '../kernel/thread-context.js';
import { createHash } from 'node:crypto';
import type { ExternalCapturedFile, ExternalAttachmentOwner } from './attachments.js';
import { isDeepStrictEqual } from 'node:util';
import type { ExternalConversation } from '@varin/application-client';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedExternalControlReceipt } from '../harness/managed-remote-types.js';
import { createManagedProcessClient } from '../kernel/managed-process-client.js';
import { KernelManagedProcess } from '../kernel/process-service.js';
import type { LaunchSource } from '../kernel/protocol.generated.js';

export interface ExternalTransportReceipt {
  id: string; processId: string; conversationId: string; source: LaunchSource;
  configurationId: string; harness: ExternalConversation['harness']; state: 'pending'|'bound'|'closed';
  authorityId?: string; resourceEpoch?: string; configurationIdentity?: string;
}
export interface ManagedExternalOwner {
  coordinatorHostId: string;
  source(owner: Extract<LaunchSource['resource_owner'],{kind:'managed_host'}>, signal?: AbortSignal): Promise<ManagedSourceClient>;
}
/** The product record remains in the coordinator Catalog. Only its exact target
 * process may execute; an uncertain old dispatch must be reconciled before resume. */
export async function openManagedExternalTransport(owner: ManagedExternalOwner, conversation: ExternalConversation,
  command: <T>(input: Record<string,unknown>)=>Promise<T>, reportError:(error:Error)=>void, signal:AbortSignal, expectedLaunch?:{command:string;args:string[];configurationIdentity?:string}) {
  const source = conversation.executionSource;
  if (!source || source.resource_owner.kind !== 'managed_host') throw new Error('External source owner is not managed');
  const client = await owner.source(source.resource_owner,signal);
  let receipt = await command<ExternalTransportReceipt>({action:'transport_prepare',id:conversation.id});
  const check = () => {
    if (receipt.conversationId !== conversation.id || receipt.configurationId !== conversation.configurationId || receipt.harness !== conversation.harness
      || receipt.id !== receipt.processId || !isDeepStrictEqual(receipt.source,source)) throw new Error('Original external transport identity changed');
  };
  check();
  const control = async (stop:boolean,release=false):Promise<ManagedExternalControlReceipt> => {
    const result = await client.externalControl({coordinatorHostId:owner.coordinatorHostId,conversationId:conversation.id,
      transportId:receipt.id,processId:receipt.processId,source,stop,...(release?{release}: {})});
    if (result.conversationId !== conversation.id || result.transportId !== receipt.id || result.processId !== receipt.processId || !isDeepStrictEqual(result.source,source)
      || result.process && (result.process.processId !== receipt.processId || result.process.workspaceId !== source.workspace_id || result.process.mode !== 'pipe')
      || result.executorStopped && !(result.notStarted === true && !result.accepted && !result.process) && !(result.process?.writerActive === false && result.process.treeConfirmed === true)) throw new Error('Original external process receipt changed');
    return result;
  };
  const stop = async () => {
    let result = await control(true);
    while (result.accepted && !result.executorStopped) {
      await new Promise<void>(resolve=>setTimeout(resolve,100)); result = await control(false);
    }
    if (!result.executorStopped) throw new Error('External target process stop is unconfirmed');
    result=await control(false,true);
    if(!result.executorStopped || !result.outputReleased)throw new Error('External target process output release is unconfirmed');
    await command({action:'transport_closed',id:conversation.id,transportId:receipt.id});
    return result;
  };
  // A previous coordinator may have sent protocol requests whose replies were
  // lost. Never replay its output into a fresh protocol peer or duplicate it.
  const existing = await control(false);
  if (existing.accepted || existing.executorStopped || receipt.state === 'bound') {
    await stop();
    receipt = await command<ExternalTransportReceipt>({action:'transport_prepare',id:conversation.id}); check();
  }
  const launch = await client.externalBinding({coordinatorHostId:owner.coordinatorHostId,source,
    configurationId:conversation.configurationId,harness:conversation.harness,...(conversation.sessionId?{sessionId:conversation.sessionId}:{})},signal);
  if(expectedLaunch && (!isDeepStrictEqual({command:launch.configuration.command,args:launch.configuration.args},{command:expectedLaunch.command,args:expectedLaunch.args}) || expectedLaunch.configurationIdentity !== undefined && expectedLaunch.configurationIdentity !== launch.configurationIdentity))throw new Error('Original target external Harness launch changed after input admission');
  const binding = await client.bind({coordinatorHostId:owner.coordinatorHostId,scope:{kind:'external',conversationId:conversation.id,transportId:receipt.id},
    purpose:'external_harness',operationId:receipt.processId,retention:'caller',source:resourceThreadSource(source)!},signal);
  if (!binding.physicalRoot) throw new Error('External target physical source is unavailable');
  await command({action:'transport_bind',id:conversation.id,transportId:receipt.id,authorityId:binding.authorityId,
    resourceEpoch:binding.resourceEpoch,configurationIdentity:launch.configurationIdentity});
  const address = {coordinatorHostId:owner.coordinatorHostId,authorityId:binding.authorityId,resourceEpoch:binding.resourceEpoch,processId:receipt.processId};
  // No abort after dispatch: preserve unknown response and its original receipt.
  const initial = await client.externalSpawn({...address,launch,...(conversation.sessionId?{sessionId:conversation.sessionId}:{})});
  if (initial.processId !== receipt.processId || initial.workspaceId !== source.workspace_id || initial.mode !== 'pipe') throw new Error('External target process identity changed');
  const projection = createManagedProcessClient(client,address,{workspaceId:source.workspace_id,rootId:binding.physicalRoot.rootId});
  projection.processRelease = async () => {const result=await stop();if(!result.process)throw new Error('Original external process release receipt missing');return result.process;};
  projection.processKill = async () => {const result=await stop();if(!result.process)throw new Error('Original external process stop receipt missing');return {...result.process};};
  const child = new KernelManagedProcess(projection,{workspaceId:source.workspace_id,rootId:binding.physicalRoot.rootId,processId:receipt.processId},initial,reportError,()=>{}, {retainOutput:true,terminate:async()=>{await stop();}});
  // Attach Harness listeners before subscribing so startup bytes cannot be lost.
  let closing:Promise<void>|undefined;
  const close=()=>{
    closing??=(async()=>{await stop();await child.detach();})().catch(error=>{closing=undefined;throw error;});
    return closing;
  };
  const attachmentOwner = (original:ExternalAttachmentOwner):ExternalAttachmentOwner => ({...original,
    async externalPath(c,ref,attachmentSignal) {
      const retained = await original.readExternal(c,ref,attachmentSignal);
      const digest=createHash('sha256');let length=0;
      for await (const bytes of retained.stream) {attachmentSignal?.throwIfAborted();digest.update(bytes);length+=bytes.byteLength;}
      if(length!==retained.attachment.byteLength)throw new Error('Original external attachment changed');
      const contentHash=`sha256-${digest.digest('hex')}`;
      const operationId=`external-file:${createHash('sha256').update(JSON.stringify([conversation.id,ref])).digest('hex')}`;
      const request={...address,operationId,attachment:retained.attachment,contentHash};
      const imported=await client.attachmentBegin(request,attachmentSignal);
      if(!imported.complete){
        const bytes=await original.readExternal(c,ref,attachmentSignal);
        if(!isDeepStrictEqual(bytes.attachment,retained.attachment))throw new Error('Original external attachment changed');
        await client.attachmentPut({...address,operationId,ref,contentHash,objectHash:contentHash,byteLength:length},bytes.stream,attachmentSignal);
      }
      const view=await client.attachmentPath(request,attachmentSignal);
      return {path:view.path,kernelEpoch:binding.resourceEpoch};
    }
  });
  const capture=async(key:string,path:string,captureSignal?:AbortSignal):Promise<ExternalCapturedFile>=>{
    const request={...address,key,path};
    const metadata=await client.externalCapture({...request,action:'capture'},captureSignal) as Pick<ExternalCapturedFile,'filename'|'mimeType'|'byteLength'|'contentHash'>;
    const readPage:ExternalCapturedFile['readPage']=async(offset,length,view)=>client.externalCapture({...request,action:'read',offset,length,...view},captureSignal) as Promise<import('../kernel/protocol.generated.js').KernelObjectSlice>;
    const chunks=(async function*(){let offset=0;while(offset<metadata.byteLength){const page=await readPage(offset,Math.min(256*1024,metadata.byteLength-offset));const bytes=Buffer.from(page.bytesBase64,'base64');
      if(page.hash!==metadata.contentHash||page.byteLength!==metadata.byteLength||page.offset!==offset||page.nextOffset!==offset+bytes.length||!bytes.length)throw new Error('Original remote capture changed');offset=page.nextOffset;yield bytes;}})();
    return {...metadata,chunks,readPage,release:async(committed)=>{await client.externalCapture({...request,action:'release',...(committed?{committed}: {})});}};
  };
  return {child,start:()=>child.start(),close,launch,executionCwd:binding.physicalRoot.canonicalRoot,attachmentOwner,capture};
}

/** Also used after coordinator restart/deletion, when no live peer exists. */
export async function closeManagedExternalTransport(owner:ManagedExternalOwner, conversation:ExternalConversation,
  command:<T>(input:Record<string,unknown>)=>Promise<T>) {
  const source=conversation.executionSource;
  if(!source || source.resource_owner.kind!=='managed_host')return;
  const current=await command<ExternalConversation & {transport?:ExternalTransportReceipt}>({action:'inspect',id:conversation.id});
  const transport=current.transport;if(!transport || transport.state==='closed'&&!current.deleted)return;
  if(!isDeepStrictEqual(transport.source,source)||transport.conversationId!==conversation.id||transport.id!==transport.processId)throw new Error('Original external transport changed');
  const client=await owner.source(source.resource_owner);
  const input={coordinatorHostId:owner.coordinatorHostId,conversationId:conversation.id,transportId:transport.id,processId:transport.processId,source,...(current.deleted?{releaseCaptures:true}:{})};
  let receipt=await client.externalControl({...input,stop:true});
  while(receipt.accepted&&!receipt.executorStopped){await new Promise<void>(resolve=>setTimeout(resolve,100));receipt=await client.externalControl({...input,stop:false});}
  const validate=(receipt:ManagedExternalControlReceipt)=>{if(receipt.conversationId!==conversation.id||receipt.transportId!==transport.id||receipt.processId!==transport.processId||!isDeepStrictEqual(receipt.source,source)
    ||receipt.process && (receipt.process.processId!==transport.processId||receipt.process.workspaceId!==source.workspace_id||receipt.process.mode!=='pipe')
    ||!receipt.executorStopped || !(receipt.notStarted===true&&!receipt.accepted&&!receipt.process) && !(receipt.process?.writerActive===false&&receipt.process.treeConfirmed===true))throw new Error('External target stop is unconfirmed');};
  validate(receipt);
  receipt=await client.externalControl({...input,stop:false,release:true});
  validate(receipt);
  if(!receipt.outputReleased)throw new Error('Original external output release is unconfirmed');
  await command({action:'transport_closed',id:conversation.id,transportId:transport.id});
}
