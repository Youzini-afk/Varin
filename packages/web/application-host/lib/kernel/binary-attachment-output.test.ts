import { expect, it, vi } from 'vitest';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { JsonValue } from '@varin/extension-contract';
import { createOfficeRuntime } from './office-runtime.js';
import { createBrowserRuntime } from './browser-runtime.js';
import { writeSourceBinary } from './binary-file-owner.js';
import { withToolInvocation, type ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';

const owner = { extensionId: 'varin.builtin.office', extensionVersion: '1', entrypointId: 'host', instanceKey: 'file-output', generation: 1 };
const attachment = { ref: 'attachment:original', filename: 'report.pdf', mimeType: 'application/pdf', byteLength: 3 };
const source = { mode: 'live_root', workspace_id: 'workspace' };
const settings = async () => ({ global: {}, project: {}, globalRevision: '1', projectRevision: '1', projectTrusted: false });
const runtime = { run: async () => ({ thread_id: 'thread' }), familyList: async () => ({ rootThreadId: 'thread' }) };

/** Native receipts are a controlled port; these tests exercise the real binary
 * result adapter, domain capability and invocation-owned typed output channel. */
function files() {
  const client = { fileOperationReconcile: vi.fn(async () => ({ status: 'reconciled', result: { status: 'applied', attachment,
    stateJson: JSON.stringify({ kind: 'regular-file', objectHash: 'sha256-original', byteLength: 3 }) } })) };
  return { client, write: async (authority: ToolInvocationAuthority, input: { path: string; bytes: Uint8Array; expectedRevision: string | null }) =>
    writeSourceBinary({ ...input, client, rootId: 'root', source, operationId: authority.operationId, tool: authority.toolName, journal: {} } as unknown as Parameters<typeof writeSourceBinary>[0]) };
}
async function invoke(capability: HostCapabilityHandler, method: string, toolName: string, args: JsonValue) {
  const signal = new AbortController().signal;
  let result: ToolExecutionReceipt | undefined;
  await withToolInvocation({ owner, signal, onEffectReceipt: receipt => { result = receipt; }, authority: {
    invocationId: 'invocation', runId: 'run', threadId: 'thread', callId: 'file', operationId: 'request:tool:file',
    origin: { kind: 'model_step', request_id: 'request' }, executorOwner: { kind: 'kernel' }, source: null,
    toolName, operation: 'effect', completion: 'result', configurationIdentity: JSON.stringify({ version: 1, disabled: [] }), arguments: args,
  } }, async invocation => capability(method, args, { owner, signal, invocation }));
  expect(result).toMatchObject({ executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed',
    content: { data: { attachment }, parts: [{ kind: 'attachment', attachment }] } } });
  return result;
}

it('Office writes and exports expose the fixed native attachment in the actual tool receipt', async () => {
  const writer = files();
  const office = createOfficeRuntime({ runtime, files: writer, settings, sources: { tool: () => ({}) },
    reader: { load: async () => ({ bytes: Buffer.from('office'), package: { format: 'docx' } }) },
    renderer: { convert: async () => ({ bytes: Buffer.from('pdf'), format: 'pdf', engine: 'fixture', recalculated: false }) },
  } as unknown as Parameters<typeof createOfficeRuntime>[0]);
  await invoke(office.capability, 'write', 'office_write', { action: 'create', path: 'report.docx', content: { format: 'docx', blocks: [{ kind: 'paragraph', text: 'Report' }] } });
  await invoke(office.capability, 'export', 'office_export', { sourcePath: 'report.docx', path: 'report.pdf', format: 'pdf' });
  expect(writer.client.fileOperationReconcile).toHaveBeenCalledTimes(2);
});

it('browser saved downloads keep the fixed attachment even if download-cache cleanup fails', async () => {
  const writer = files(), releaseDownload = vi.fn(async () => { throw new Error('cache is busy'); });
  const browser = createBrowserRuntime({ runtime, files: writer, settings,
    browser: { retainForThread() {}, readDownload: async () => ({ bytes: Buffer.from('pdf') }), releaseDownload },
  } as unknown as Parameters<typeof createBrowserRuntime>[0]);
  const result = await invoke(browser.capability, 'files', 'browser_files', { action: 'save', pageId: 'page', downloadId: 'download', path: 'report.pdf' });
  expect(result).toMatchObject({ completion: { content: { data: { cleanupPending: true } } } });
  expect(releaseDownload).toHaveBeenCalledOnce();
});

it('browser upload reads an observed file through its pinned attachment owner instead of reopening the raw path', async () => {
  const readRef=vi.fn(async () => ({source:Buffer.from('observed bytes'),title:'original.pdf'}));
  const readPath=vi.fn(async () => {throw new Error('must not reopen mutable source');});
  const upload=vi.fn(async () => ({accepted:true}));
  const browser=createBrowserRuntime({runtime,settings,sources:{tool:()=>({readRef,readPath})},browser:{retainForThread(){},upload},
  } as unknown as Parameters<typeof createBrowserRuntime>[0]);
  const signal=new AbortController().signal;
  const args={pageId:'page',action:'upload',ref:'element:2',files:[{path:'file:17'}]};
  let receipt:ToolExecutionReceipt|undefined;
  await withToolInvocation({owner,signal,onEffectReceipt:value=>{receipt=value;},authority:{
    invocationId:'upload',runId:'run',threadId:'thread',callId:'upload',operationId:'request:tool:upload',origin:{kind:'model_step',request_id:'request'},executorOwner:{kind:'kernel'},source:null,
    toolName:'browser_files',operation:'effect',completion:'result',configurationIdentity:JSON.stringify({version:1,disabled:[]}),arguments:args,
  }},async invocation=>browser.capability('files',args,{owner,signal,invocation}));
  expect(readRef).toHaveBeenCalledWith('file:17',signal);expect(readPath).not.toHaveBeenCalled();
  expect(upload).toHaveBeenCalledWith('page','element:2',[{name:'original.pdf',bytes:Buffer.from('observed bytes')}],signal);
  expect(receipt).toMatchObject({completion:{kind:'result',outcome:'succeeded',effect:'confirmed'}});
});

it('Office replacement inherits the observed version and rejects conflicting revisions before writing', async()=>{
  const {createOfficeFile}=await import('../office/create.js');
  const {OfficePackage}=await import('../office/package.js');
  const bytes=await createOfficeFile({format:'docx',blocks:[{kind:'paragraph',text:'Original'}]},async()=>{throw new Error('No image');},new AbortController().signal);
  const revision=new OfficePackage(bytes).revision;
  const readRef=vi.fn(async()=>({source:bytes,title:'report.docx'})),write=vi.fn(async(_authority:ToolInvocationAuthority,_input:{path:string;bytes:Uint8Array;expectedRevision:string|null})=>({status:'applied',executorStopped:true,fileJournal:true,operationId:'request:tool:replace'}));
  const office=createOfficeRuntime({runtime,settings,sources:{tool:()=>({readRef})},files:{write}} as unknown as Parameters<typeof createOfficeRuntime>[0]);
  for(const expectedRevision of [undefined,'different-revision']){
    const original={action:'replace',path:'file:31',content:{format:'docx',blocks:[{kind:'paragraph',text:'Replacement'}]},...(expectedRevision?{expectedRevision}:{})};
    const resolved={...original,path:'report.docx'};const signal=new AbortController().signal;
    let result:ToolExecutionReceipt|undefined;
    await withToolInvocation({owner,signal,onEffectReceipt:value=>{result=value;},authority:{
      invocationId:'replace',runId:'run',threadId:'thread',operationId:'request:tool:replace',callId:'replace',origin:{kind:'model_step',request_id:'request'},executorOwner:{kind:'kernel'},source:null,
      toolName:'office_write',operation:'effect',completion:'result',configurationIdentity:JSON.stringify({version:1,disabled:[]}),arguments:original,resolvedArguments:resolved,
    }},async invocation=>office.capability('write',resolved,{owner,signal,invocation}));
    expect(result).toMatchObject({completion:{kind:'result',outcome:expectedRevision?'failed':'succeeded'}});
  }
  expect(write).toHaveBeenCalledOnce();expect(write.mock.calls[0]![1]).toMatchObject({path:'report.docx',expectedRevision:revision});
});
