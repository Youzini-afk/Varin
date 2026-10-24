import path from 'node:path';
import { BROWSER_CAPABILITY, BROWSER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { AgentSettingsSnapshot } from '@varin/application-client';
import type { BrowserAction, BrowserOwner, BrowserReadRequest } from '@varin/protocol';
import { isBrowserExecutionError } from '@varin/protocol';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { LaunchSource } from './protocol.generated.js';
import type { DocumentSources } from './document-sources.js';
import type { createBinaryFileOwner } from './binary-file-owner.js';
import type { DocumentReader, DocumentReaderContext } from '../harness/document-reading.js';
import type { WebMaterialStore } from '../harness/web-materials.js';
import type { OfficeReader } from '../office/reader.js';
import { compileToolJsonSchema } from '../models/schema.js';
import { runToolDomainCall, type ToolInvocationAuthority } from './tool-invocation.js';
import { createToolFamilySettings } from './tool-family-settings.js';
import { threadMaterialScope } from './material-storage.js';
import { webOutput } from './web-runtime.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';

export { BROWSER_CAPABILITY };
export function createBrowserRuntime(options: {
  browser?: BrowserOwner | undefined; runtime: Pick<AgentRuntimeClient, 'run' | 'familyList'>; sources: DocumentSources;
  files: ReturnType<typeof createBinaryFileOwner>; materials: WebMaterialStore; documents: DocumentReader; office: OfficeReader;
  settings(source: LaunchSource | null): Promise<AgentSettingsSnapshot>;
}) {
  const settings = createToolFamilySettings(BROWSER_TOOL_DECLARATIONS, options.settings, () => Boolean(options.browser));
  const declarations = new Map(BROWSER_TOOL_DECLARATIONS.map(declaration => [declaration.id.slice('varin.browser.'.length),
    { declaration, validate: compileToolJsonSchema(declaration.tool!.inputSchema) }]));
  const materialContext = async (invocation: ToolInvocationAuthority, signal: AbortSignal): Promise<DocumentReaderContext> => {
    const run = await options.runtime.run(invocation.runId, signal);
    if (run.thread_id !== invocation.threadId) throw new Error('The browser invocation changed its original Thread');
    const family = await options.runtime.familyList({ callerThreadId: invocation.threadId, includeSelf: true }, signal);
    const workspaceId = threadMaterialScope(family.rootThreadId);
    return { workspaceId, authority: { kind: 'thread', owningWorkspaceId: workspaceId, threadId: invocation.threadId }, signal };
  };
  const capability: HostCapabilityHandler = async (method, value, call) => {
    const selected = declarations.get(method);
    if (!selected || !selected.validate(value)) throw new Error('Browser arguments do not match this operation; use the declared pageId, ref and source fields');
    const input = parseVarinToolJson(value) as Record<string, unknown>;
    return runToolDomainCall(call, { domain: BROWSER_CAPABILITY, toolName: selected.declaration.tool!.name,
      operation: selected.declaration.tool!.operation, arguments: parseVarinToolJson(input) }, async invocation => {
      let effectStarted = false;
      const success = (data: unknown, effect: 'none' | 'confirmed' = 'none'): ToolExecutionReceipt => ({ executor_stopped: true,
        completion: { kind: 'result', outcome: 'succeeded', effect, content: { data: parseVarinToolJson(data), parts: [] } } });
      try {
        settings.assertEnabled(invocation.configurationIdentity, invocation.toolName);
        const browser = options.browser;
        if (!browser) throw new Error('This Host has no connected built-in browser. Use computer_browser on an explicitly connected desktop, or webfetch for document retrieval.');
        call.signal.throwIfAborted();
        if (method === 'tabs') return success({ browserId: browser.browserId, pages: await browser.list() });
        if (method === 'open') {
          effectStarted = true;
          return success({ page: await browser.open(input as unknown as Parameters<BrowserOwner['open']>[0], { threadId: invocation.threadId, signal: call.signal }) }, 'confirmed');
        }
        const pageId = String(input.pageId); browser.retainForThread(pageId, invocation.threadId);
        if (method === 'read') {
          const { image, ...observation } = await browser.read(input as unknown as BrowserReadRequest, call.signal);
          const receipt = success(observation);
          if (image && receipt.completion.kind === 'result') receipt.completion.content.parts = [{ kind: 'media', media: { media_type: image.mimeType, data_base64: image.base64 } }];
          return receipt;
        }
        if (method === 'act') { effectStarted = true; return success(await browser.act(pageId, input as unknown as BrowserAction, call.signal), input.action === 'wait' ? 'none' : 'confirmed'); }
        if (input.action === 'downloads') return success({ pageId, downloads: await browser.downloads(pageId) });
        if (input.action === 'save') {
          const download = await browser.readDownload(pageId, String(input.downloadId), call.signal);
          effectStarted = true;
          const written = await options.files.write(invocation, { path: String(input.path), expectedRevision: typeof input.expectedRevision === 'string' ? input.expectedRevision : null, bytes: download.bytes }, call.signal);
          // The native receipt is authoritative even when the private download
          // cache cannot be removed yet. A completed save is never reported undone.
          let cleanupPending = false;
          if (written.status === 'applied') try { await browser.releaseDownload(pageId, String(input.downloadId)); } catch { cleanupPending = true; }
          return { executor_stopped: written.executorStopped, completion: { kind: 'result', outcome: written.status === 'applied' ? 'succeeded' : written.status === 'conflict' ? 'failed' : 'indeterminate',
            effect: written.status === 'applied' ? 'confirmed' : written.status === 'conflict' ? 'none' : 'unknown', content: { data: parseVarinToolJson({ ...written, ...(cleanupPending ? { cleanupPending: true } : {}) }), parts: [] } } };
        }
        const context = await materialContext(invocation, call.signal);
        if (input.action === 'read') {
          const download = await browser.readDownload(pageId, String(input.downloadId), call.signal);
          const source = { source: Buffer.from(download.bytes), title: download.name, sourceUrl: `varin-browser://${browser.browserId}/${pageId}/downloads/${String(input.downloadId)}` };
          const office = await options.office.document({ view: 'overview' }, context, source);
          const result = office ?? await options.documents.ingest({ ...source, contentType: 'application/pdf' }, context, { view: 'overview' });
          return { executor_stopped: true, completion: { kind: 'result', outcome: result.status === 'ok' ? 'succeeded' : 'failed', effect: 'none', content: webOutput(result) } };
        }
        const files = await Promise.all((input.files as { path?: string; snapshotId?: string }[]).map(async file => {
          if (file.path) { const original = await options.sources.tool(invocation).readPath!(file.path, call.signal); return { name: path.basename(file.path), bytes: original.source }; }
          const original = await options.materials.read(context.workspaceId, file.snapshotId!, context.authority, { includeSource: true, signal: call.signal });
          if (!original?.source) throw new Error('The selected attachment has no accessible original file');
          return { name: path.basename(original.ref.title || 'attachment'), bytes: original.source.bytes };
        }));
        effectStarted = true; return success(await browser.upload(pageId, String(input.ref), files, call.signal), 'confirmed');
      } catch (error) {
        if (isBrowserExecutionError(error)) effectStarted = error.effect !== 'none';
        // Broker cancellation can finish observing first; the original domain
        // invocation keeps its lease until the page execution really settles.
        if (isBrowserExecutionError(error) && error.completion) await error.completion;
        return { executor_stopped: isBrowserExecutionError(error) ? error.executorStopped || !!error.completion : true, completion: { kind: 'result', outcome: effectStarted ? 'indeterminate' : call.signal.aborted ? 'cancelled' : 'failed',
          effect: effectStarted ? 'unknown' : 'none', content: { data: { status: effectStarted ? 'unknown' : 'failed', message: error instanceof Error ? error.message : String(error),
            ...(effectStarted ? { next: 'Read the original page or file receipt before repeating an operation with possible effects.' } : {}) }, parts: [] } } };
      }
    });
  };
  return { capability, prepareConfiguration: settings.prepareConfiguration };
}
