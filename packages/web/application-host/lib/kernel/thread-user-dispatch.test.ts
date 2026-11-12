import { beforeEach, expect, it, vi } from 'vitest';
import type { ThreadDispatchInput } from '@varin/application-client';
import { createThreadUserDispatch, parseThreadDispatchInput } from './thread-user-dispatch.js';
import { ThreadAdapter, ThreadPreAdmissionError } from './thread-adapter.js';
import { KernelRequestError } from './kernel-error.js';
import { readDelegationModelCatalog } from '../models/delegation-catalog.js';
vi.mock('../models/delegation-catalog.js', () => ({ readDelegationModelCatalog: vi.fn() }));
const input:ThreadDispatchInput={runtime:'agent',threadId:'parent',branchId:'主线',runId:'original-run',expectedHead:'original-head',key:'confirm-once',text:'Edited instructions',model:'chosen',thinking:'high',projectId:null,workMode:'shared',background:[{threadId:'parent',branchId:'主线',headId:'original-head',itemIds:['selected-item']}],attachments:[{ref:'attachment:original'}]};
const original={operationId:'user-dispatch:6:主线:confirm-once',executionId:'user-dispatch:6:主线:confirm-once',threadId:'thread:child:user-dispatch:6:主线:confirm-once',branchId:'child-branch',actor:{kind:'user' as const},acceptedCursor:50,acceptedAtMs:100};
const file={ref:'attachment:original',filename:'notes.txt',mimeType:'text/plain',byteLength:5};
function fixture() {
  const runtime={thread:vi.fn(async()=>({deleted_at_ms:null,branches:[{branch_id:input.branchId,head:input.expectedHead,active_run_id:null,latest_run:{id:input.runId}}]})),userChildDispatchCatalog:vi.fn(async()=>({runId:input.runId,headId:input.expectedHead,projects:[{id:'project',name:'Project',path:'/original',resource_owner:{kind:'local'}}]})),userChildDispatchReceipt:vi.fn(async()=>null as typeof original|null),acceptUserChildDispatch:vi.fn(async()=>original)};
  const attachments={prepare:vi.fn(async()=>[file]),read:vi.fn(async()=>({stream:(async function*(){yield Buffer.from('image');})()})),releaseUnpublished:vi.fn(async()=>{})};
  const ensureOrganization=vi.fn(async()=>{});
  const owners={runtime,attachments,models:{},ensureOrganization} as unknown as Parameters<typeof createThreadUserDispatch>[0];
  return {runtime,attachments,ensureOrganization,api:createThreadUserDispatch(owners)};
}
beforeEach(()=>{vi.mocked(readDelegationModelCatalog).mockReset().mockResolvedValue({selector:null,candidates:[{id:'chosen',name:'Chosen',channelName:'Original channel',providerId:'channel',modelId:'model',configurationFingerprint:'fixed',input:['text','image'],thinkingLevels:['high'],defaultThinkingLevel:'high',billing:'local'}]});});
it('reads original native source catalog and exposes no tool/model credential authority',async()=>{
 const f=fixture();const catalog=await f.api.catalog(input);expect(catalog).toEqual({runId:input.runId,headId:input.expectedHead,projects:[{id:'project',name:'Project',path:'/original'}],models:[{id:'chosen',name:'Chosen',channelName:'Original channel',thinkingLevels:['high'],defaultThinkingLevel:'high'}]});
});
it('does not create a task when opening a catalog for an empty Thread',async()=>{
 const f=fixture();f.runtime.thread.mockResolvedValueOnce({deleted_at_ms:null,branches:[{branch_id:input.branchId,head:null,active_run_id:null,latest_run:null}]} as never);expect((await f.api.catalog(input)).runId).toBeNull();expect(f.runtime.acceptUserChildDispatch).not.toHaveBeenCalled();expect(f.attachments.prepare).not.toHaveBeenCalled();
});
it('admits exact edited instructions, selected refs, explicit source and prepared original attachments',async()=>{
 const f=fixture();expect(await f.api.dispatch(input)).toEqual(original);expect(f.attachments.prepare).toHaveBeenCalledWith(input,input.attachments,original.operationId,original.threadId,undefined);
 const sent=f.runtime.acceptUserChildDispatch.mock.calls[0] as unknown as [Record<string,unknown>];expect(sent[0]).toEqual({key:input.key,threadId:input.threadId,branchId:input.branchId,runId:input.runId,expectedHead:input.expectedHead,input:{task:input.text,model:input.model,thinking:'high',workMode:'shared',background:input.background,attachments:input.attachments},preparedAttachments:[file],preparedAttachmentMedia:[]});
 expect(sent[0]).not.toHaveProperty('actor');expect(sent[0]).not.toHaveProperty('origin');expect(sent[0]).not.toHaveProperty('callId');
});
it('returns the exact existing receipt before settings or attachment revalidation',async()=>{
 const f=fixture();f.runtime.userChildDispatchReceipt.mockResolvedValueOnce(original);vi.mocked(readDelegationModelCatalog).mockRejectedValueOnce(new Error('configuration removed'));expect(await f.api.dispatch(input)).toEqual(original);expect(readDelegationModelCatalog).not.toHaveBeenCalled();expect(f.attachments.prepare).not.toHaveBeenCalled();expect(f.runtime.acceptUserChildDispatch).not.toHaveBeenCalled();
});
it('passes an explicit work focus independently of file mode and rejects unknown focuses', async () => {
  const f = fixture();
  await f.api.dispatch({ ...input, workFocus: 'research' });
  expect(f.runtime.acceptUserChildDispatch).toHaveBeenCalledWith(expect.objectContaining({
    input: expect.objectContaining({ workFocus: 'research', workMode: 'shared' }),
  }), undefined);
  expect(() => parseThreadDispatchInput({ ...input, workFocus: 'coding' })).toThrow(ThreadPreAdmissionError);
});
it('rejects invented actor or implicit source and exposes an editable pre-admission rejection',()=>{
 expect(()=>parseThreadDispatchInput({...input,actor:{kind:'agent'}})).toThrow(ThreadPreAdmissionError);expect(()=>parseThreadDispatchInput({...input,projectId:undefined})).toThrow(ThreadPreAdmissionError);expect(()=>parseThreadDispatchInput({...input,background:[{...input.background![0],itemIds:[]}]})).toThrow(ThreadPreAdmissionError);
});
it('cancellation before native admission releases prepared files and creates no task',async()=>{
 const f=fixture(),cancel=new AbortController();f.attachments.prepare.mockImplementationOnce(async()=>{cancel.abort();return [file];});await expect(f.api.dispatch(input,cancel.signal)).rejects.toBeInstanceOf(ThreadPreAdmissionError);expect(f.runtime.acceptUserChildDispatch).not.toHaveBeenCalled();expect(f.attachments.releaseUnpublished).toHaveBeenCalledOnce();
});
it('native confirmed rejection enables editing, but unknown outcomes preserve dependencies and exact retry',async()=>{
 const rejected=fixture();rejected.runtime.acceptUserChildDispatch.mockRejectedValueOnce(new KernelRequestError(new Error('stale branch'),'runtime.child.user.accept','response'));await expect(rejected.api.dispatch(input)).rejects.toBeInstanceOf(ThreadPreAdmissionError);expect(rejected.attachments.releaseUnpublished).toHaveBeenCalledOnce();
 const unknown=fixture(),failure=new Error('transport disconnected');unknown.runtime.acceptUserChildDispatch.mockRejectedValueOnce(failure);await expect(unknown.api.dispatch(input)).rejects.toBe(failure);expect(unknown.attachments.releaseUnpublished).not.toHaveBeenCalled();unknown.runtime.userChildDispatchReceipt.mockResolvedValueOnce(original);expect(await unknown.api.dispatch(input)).toEqual(original);expect(unknown.runtime.acceptUserChildDispatch).toHaveBeenCalledOnce();
});
it('a committed receipt wins over an uncertain response without releasing the admitted files',async()=>{
 const f=fixture();f.runtime.userChildDispatchReceipt.mockResolvedValueOnce(null).mockResolvedValueOnce(original);f.runtime.acceptUserChildDispatch.mockRejectedValueOnce(new KernelRequestError(new Error('late response'),'runtime.child.user.accept','response'));expect(await f.api.dispatch(input)).toEqual(original);expect(f.attachments.releaseUnpublished).not.toHaveBeenCalled();
});
it('direct images use original bytes and reject an incompatible explicit model before dispatch',async()=>{
 const f=fixture();f.attachments.prepare.mockResolvedValueOnce([{...file,mimeType:'image/png'}]);await f.api.dispatch(input);expect(f.runtime.acceptUserChildDispatch).toHaveBeenCalledWith(expect.objectContaining({preparedAttachmentMedia:[{media_type:'image/png',data_base64:Buffer.from('image').toString('base64')}]}),undefined);
 const g=fixture();g.attachments.prepare.mockResolvedValueOnce([{...file,mimeType:'image/png'}]);const catalog=await readDelegationModelCatalog({} as never,{enabled:false});vi.mocked(readDelegationModelCatalog).mockResolvedValueOnce({...catalog,candidates:catalog.candidates.map(item=>({...item,input:['text']}))});await expect(g.api.dispatch(input)).rejects.toBeInstanceOf(ThreadPreAdmissionError);expect(g.runtime.acceptUserChildDispatch).not.toHaveBeenCalled();
});
it('serializes duplicate confirmations so a rejection cannot race an earlier commit',async()=>{
 const f=fixture();let complete!:()=>void;let accepted=false;const ready=new Promise<void>(resolve=>{complete=resolve;});
 f.runtime.acceptUserChildDispatch.mockImplementationOnce(async()=>{await ready;accepted=true;return original;});
 f.runtime.userChildDispatchReceipt.mockImplementation(async()=>accepted?original:null);
 const first=f.api.dispatch(input);await vi.waitFor(()=>expect(f.runtime.acceptUserChildDispatch).toHaveBeenCalledOnce());
 const second=f.api.dispatch(input);await Promise.resolve();expect(f.runtime.userChildDispatchReceipt).toHaveBeenCalledOnce();
 complete();expect(await first).toEqual(original);expect(await second).toEqual(original);expect(f.runtime.acceptUserChildDispatch).toHaveBeenCalledOnce();
});
it('an unavailable original receipt remains uncertain rather than allowing a replacement task',async()=>{
 const f=fixture(),error=new Error('original owner offline');f.runtime.userChildDispatchReceipt.mockRejectedValueOnce(error);await expect(f.api.dispatch(input)).rejects.toBe(error);expect(f.runtime.acceptUserChildDispatch).not.toHaveBeenCalled();
});

it('cancels a User-admitted child through the original tree owner', async () => {
  const runtime = { operationStatus: vi.fn(async () => ({ run_id: 'parent-run', executor: 'user_dispatch' })),
    run: vi.fn(async () => ({ id: 'parent-run', thread_id: 'thread:parent', branch_id: 'main' })),
    thread: vi.fn(async () => ({ deleted_at_ms: null, branches: [{ branch_id: 'main' }] })),
    cancelTree: vi.fn(async () => undefined), cancelOperation: vi.fn(async () => undefined) };
  const adapter = new ThreadAdapter(runtime as never, {} as never, async () => {}, () => {});
  await adapter.cancelOperation('user-operation');
  expect(runtime.cancelTree).toHaveBeenCalledExactlyOnceWith({ kind: 'child', operation_id: 'user-operation' });
  expect(runtime.cancelOperation).not.toHaveBeenCalled();
});

it('initializes project navigation after original receipt lookup and before new admission', async () => {
  const f=fixture();
  await f.api.dispatch({...input, projectId:'registered'});
  expect(f.ensureOrganization).toHaveBeenCalledOnce();
  expect(f.runtime.userChildDispatchReceipt.mock.invocationCallOrder[0]).toBeLessThan(f.ensureOrganization.mock.invocationCallOrder[0]!);
  expect(f.ensureOrganization.mock.invocationCallOrder[0]).toBeLessThan(f.runtime.acceptUserChildDispatch.mock.invocationCallOrder[0]!);
  f.runtime.userChildDispatchReceipt.mockResolvedValue(original);
  f.ensureOrganization.mockRejectedValue(new Error('Settings now unavailable'));
  expect(await f.api.dispatch({...input,projectId:'registered'})).toEqual(original);
  expect(f.ensureOrganization).toHaveBeenCalledOnce();
  const g=fixture(); g.ensureOrganization.mockRejectedValue(new Error('Settings unavailable'));
  await expect(g.api.dispatch({...input,projectId:'registered'})).rejects.toBeInstanceOf(ThreadPreAdmissionError);
  expect(g.runtime.acceptUserChildDispatch).not.toHaveBeenCalled();
  const inherited=fixture(); await inherited.api.dispatch(input); expect(inherited.ensureOrganization).not.toHaveBeenCalled();
});
