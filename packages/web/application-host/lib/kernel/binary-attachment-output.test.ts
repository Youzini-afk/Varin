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
