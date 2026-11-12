import {createHash} from 'node:crypto';
import type {ManagedSourceLocalScope} from '../harness/managed-remote-types.js';
import type {KernelClient} from '../kernel/kernel-client.js';
import {captureOwnedAttachment,restoreCapturedAttachment,releaseCapturedAttachments} from '../kernel/attachment-capture.js';
export interface ManagedExternalCaptureRequest {coordinatorHostId:string;authorityId:string;resourceEpoch:string;key:string;path:string;
  action:'capture'|'read'|'release';offset?:number;length?:number;representation?:'manifest';rangeObject?:string;committed?:boolean}
const captureOwner=(scope:Pick<ManagedSourceLocalScope,'scope'|'principal'|'coordinatorHostId'>)=>{
  if(scope.scope.kind!=='external')throw new Error('External capture requires its original transport authority');
  return {id:`external-capture:${createHash('sha256').update(JSON.stringify([scope.principal.principalId,scope.coordinatorHostId,scope.scope.conversationId])).digest('hex')}`};
};
/** Retains original immutable bytes in target Storage; no target product Thread. */
export async function managedExternalCapture(kernel:KernelClient,scope:ManagedSourceLocalScope,input:ManagedExternalCaptureRequest,signal?:AbortSignal){
  if(!input.key||!input.path||!scope.physicalRoot)throw new Error('External capture identity is incomplete');
  const owner=captureOwner(scope);
  const captured=await restoreCapturedAttachment(kernel,owner,input.key,input.path,signal)
    ?? (input.action==='capture' ? await captureOwnedAttachment(kernel,owner,input.key,input.path,{workspaceId:scope.source.workspace_id,
      executionWorkspaceId:scope.source.execution_workspace_id,canonicalRoot:scope.physicalRoot.canonicalRoot},signal) : undefined);
  if(!captured){if(input.action==='release')return{released:true};throw new Error('Original external capture is unavailable');}
  try{
    if(input.action==='capture')return{filename:captured.filename,mimeType:captured.mimeType,byteLength:captured.byteLength,contentHash:captured.contentHash};
    if(input.action==='read'){
      if(!Number.isSafeInteger(input.offset)||input.offset!<0||!Number.isSafeInteger(input.length)||input.length!<0)throw new Error('Invalid original capture range');
      return await captured.readPage(input.offset!,input.length!,{...(input.representation?{representation:input.representation}:{}),...(input.rangeObject?{rangeObject:input.rangeObject}:{})});
    }
    if(input.action!=='release')throw new Error('Unknown external capture action');
    return {released:true};
  }finally{await captured.release(input.action==='release'&&input.committed===true);}
}
export function cleanupManagedExternalCaptures(kernel:KernelClient,scope:Pick<ManagedSourceLocalScope,'scope'|'principal'|'coordinatorHostId'>){return releaseCapturedAttachments(kernel,captureOwner(scope).id);}
