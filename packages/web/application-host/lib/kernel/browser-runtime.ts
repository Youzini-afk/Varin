import path from 'node:path';
import { isModelReference } from './model-references.js';
import { BROWSER_CAPABILITY, BROWSER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { AgentSettingsSnapshot } from '@varin/application-client';
import type { BrowserAction, BrowserOwner, BrowserReadRequest, BrowserResourceBinding } from '@varin/protocol';
import type { BrowserResources } from '../browser/browser-resources.js';
import { BrowserExecutionError, isBrowserExecutionError } from '@varin/protocol';
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
  browser?: BrowserOwner | undefined; resources?: BrowserResources | undefined; runtime: Pick<AgentRuntimeClient, 'run' | 'familyList' | 'principalCanUseHostResources'>; sources: DocumentSources;
  files: ReturnType<typeof createBinaryFileOwner>; materials: WebMaterialStore; documents: DocumentReader; office: OfficeReader;
  settings(source: LaunchSource | null): Promise<AgentSettingsSnapshot>;
}) {
  const settings = createToolFamilySettings(BROWSER_TOOL_DECLARATIONS, options.settings, () => Boolean(options.resources || options.browser));
  const declarations = new Map(BROWSER_TOOL_DECLARATIONS.map(declaration => [declaration.id.slice('varin.browser.'.length),
    { declaration, validate: compileToolJsonSchema(declaration.tool!.inputSchema) }]));
  const materialContext = async (invocation: ToolInvocationAuthority, signal: AbortSignal, originalRun?: Awaited<ReturnType<AgentRuntimeClient['run']>>): Promise<DocumentReaderContext> => {
    const run = originalRun ?? await options.runtime.run(invocation.runId, signal);
    if (run.thread_id !== invocation.threadId) throw new Error('The browser invocation changed its original Thread');
    const family = await options.runtime.familyList({ callerThreadId: invocation.threadId, includeSelf: true }, signal);
    const workspaceId = threadMaterialScope(family.rootThreadId);
    return { workspaceId, authority: { kind: 'thread', owningWorkspaceId: workspaceId, threadId: invocation.threadId }, signal };
  };
  const capability: HostCapabilityHandler = async (method, value, call) => {
    const selected = declarations.get(method);
    if (!selected || !selected.validate(value)) throw new Error('Browser arguments do not match this operation; use the declared browserId, instanceId, pageId, ref and source fields');
    const input = parseVarinToolJson(value) as Record<string, unknown>;
    return runToolDomainCall(call, { domain: BROWSER_CAPABILITY, toolName: selected.declaration.tool!.name,
      operation: selected.declaration.tool!.operation, arguments: parseVarinToolJson(input) }, async invocation => {
      let effectStarted = false;
      let originalRun: Awaited<ReturnType<AgentRuntimeClient['run']>> | undefined;
      const success = (data: unknown, effect: 'none' | 'confirmed' = 'none'): ToolExecutionReceipt => ({ executor_stopped: true,
        completion: { kind: 'result', outcome: 'succeeded', effect, content: { data: parseVarinToolJson(data), parts: [] } } });
      try {
        settings.assertEnabled(invocation.configurationIdentity, invocation.toolName);
        if (options.runtime.principalCanUseHostResources) {
          originalRun = await options.runtime.run(invocation.runId, call.signal);
          if (originalRun.thread_id !== invocation.threadId) throw new Error('The browser invocation changed its original Thread');
          if (!await options.runtime.principalCanUseHostResources(originalRun.principal_id)) throw new Error('Host browser resources require the Host owner');
        }
        call.signal.throwIfAborted();
        if (method === 'resources') {
          if (!options.resources) throw new Error('Browser resource discovery is unavailable on this Host. No alternative desktop or browser was selected.');
          return success({ resources: await options.resources.list({ threadId: invocation.threadId }) });
        }
        const execute = async (browser: BrowserOwner, binding?: BrowserResourceBinding): Promise<ToolExecutionReceipt> => {
          try {
            const bound = (data: unknown, pageId?: string) => binding ? { ...(data as Record<string, unknown>), binding: { ...binding, ...(pageId ? { pageId } : {}) } } : data;
            const pageInput = { ...input }; delete pageInput.browserId; delete pageInput.instanceId;
            if (method === 'tabs') return success(bound({ browserId: browser.browserId, pages: await browser.list() }));
            if (method === 'open') {
              effectStarted = true;
              const page = await browser.open(pageInput as unknown as Parameters<BrowserOwner['open']>[0], { threadId: invocation.threadId, signal: call.signal });
              return success(bound({ page }, page.pageId), 'confirmed');
            }
            const pageId = String(input.pageId); browser.retainForThread(pageId, invocation.threadId);
            if (method === 'read') {
              const { image, ...observation } = await browser.read(pageInput as unknown as BrowserReadRequest, call.signal);
              const receipt = success(bound(observation, pageId));
              if (image && receipt.completion.kind === 'result') receipt.completion.content.parts = [{ kind: 'media', media: { media_type: image.mimeType, data_base64: image.base64 } }];
              return receipt;
            }
            if (method === 'act') {
            effectStarted = input.action !== 'wait';
            const { pageId: _targetPageId, ...action } = pageInput;
            return success(bound(await browser.act(pageId, action as unknown as BrowserAction, call.signal), pageId), input.action === 'wait' ? 'none' : 'confirmed');
          }
            if (input.action === 'downloads') return success(bound({ pageId, downloads: await browser.downloads(pageId) }, pageId));
            if (input.action === 'save') {
              const download = await browser.readDownload(pageId, String(input.downloadId), call.signal);
              effectStarted = true;
              const written = await options.files.write(invocation, { path: String(input.path), expectedRevision: typeof input.expectedRevision === 'string' ? input.expectedRevision : null, bytes: download.bytes }, call.signal);
              // The native receipt is authoritative even when the private download
              // cache cannot be removed yet. A completed save is never reported undone.
              let cleanupPending = false;
              if (written.status === 'applied') try { await browser.releaseDownload(pageId, String(input.downloadId)); } catch { cleanupPending = true; }
              return { executor_stopped: written.executorStopped, completion: { kind: 'result', outcome: written.status === 'applied' ? 'succeeded' : written.status === 'conflict' ? 'failed' : 'indeterminate',
                effect: written.status === 'applied' ? 'confirmed' : written.status === 'conflict' ? 'none' : 'unknown', content: { data: parseVarinToolJson({ ...written, ...(cleanupPending ? { cleanupPending: true } : {}) }),
                  parts: written.attachment ? [{ kind: 'attachment', attachment: written.attachment }] : [] } } };
            }
            const context = await materialContext(invocation, call.signal, originalRun);
            if (input.action === 'read') {
              const download = await browser.readDownload(pageId, String(input.downloadId), call.signal);
              const source = { source: Buffer.from(download.bytes), title: download.name, sourceUrl: `varin-browser://${encodeURIComponent(binding?.browserId ?? browser.browserId)}/${encodeURIComponent(binding?.instanceId ?? 'local')}/${encodeURIComponent(pageId)}/downloads/${encodeURIComponent(String(input.downloadId))}` };
              const office = await options.office.document({ view: 'overview' }, context, source);
              const result = office ?? await options.documents.ingest({ ...source, contentType: 'application/pdf' }, context, { view: 'overview' });
              return { executor_stopped: true, completion: { kind: 'result', outcome: result.status === 'ok' ? 'succeeded' : 'failed', effect: 'none', content: webOutput(result) } };
            }
            const files = await Promise.all((input.files as { path?: string; snapshotId?: string }[]).map(async file => {
              if (file.path) {
                const sources = options.sources.tool(invocation);
                const original = await (isModelReference(file.path,'file') ? sources.readRef!(file.path,call.signal) : sources.readPath!(file.path,call.signal));
                return { name: path.basename(original.title || file.path), bytes: original.source };
              }
              const original = await options.materials.read(context.workspaceId, file.snapshotId!, context.authority, { includeSource: true, signal: call.signal });
              if (!original?.source) throw new Error('The selected attachment has no accessible original file');
              return { name: path.basename(original.ref.title || 'attachment'), bytes: original.source.bytes };
            }));
            effectStarted = true; return success(bound(await browser.upload(pageId, String(input.ref), files, call.signal), pageId), 'confirmed');
          } catch (error) {
            // The resource owner must see the same uncertainty as the tool
            // receipt, so it can fence input until a fresh observation.
            throw isBrowserExecutionError(error) ? error : new BrowserExecutionError(error, effectStarted ? 'unknown' : 'none');
          }
        };
        if (options.resources) {
          const target = { ...(typeof input.browserId === 'string' ? { browserId: input.browserId } : {}),
            ...(typeof input.instanceId === 'string' ? { instanceId: input.instanceId } : {}),
            ...(typeof input.pageId === 'string' ? { pageId: input.pageId } : {}) };
          if (target.pageId && (!target.browserId || !target.instanceId)) throw new Error('A raw pageId requires its original browserId and instanceId. Use a page reference from browser_tabs, browser_open or browser_read.');
          return await options.resources.use(target, { threadId: invocation.threadId, runId: invocation.runId,
            operationId: invocation.operationId, signal: call.signal }, execute,
            { writes: method === 'open' || method === 'act' && input.action !== 'wait' || method === 'files' && input.action === 'upload', observes: method === 'read' });
        }
        // Trusted embedders may still supply one original owner directly. Model
        // resource selections are never allowed to silently fall back to it.
        if (input.browserId !== undefined || input.instanceId !== undefined) throw new Error('Browser resource routing is unavailable on this Host. No alternative browser was selected.');
        if (!options.browser) throw new Error('This Host has no connected browser resource. Discover or connect a browser before retrying; webfetch can retrieve documents without browser interaction.');
        return await execute(options.browser);
      } catch (error) {
        if (isBrowserExecutionError(error)) effectStarted = error.effect !== 'none';
        // Broker cancellation can finish observing first; the original domain
        // invocation keeps its lease until the page execution really settles.
        if (isBrowserExecutionError(error) && error.completion) await error.completion.catch(() => undefined);
        return { executor_stopped: isBrowserExecutionError(error) ? error.executorStopped || !!error.completion : true, completion: { kind: 'result', outcome: effectStarted ? 'indeterminate' : call.signal.aborted ? 'cancelled' : 'failed',
          effect: effectStarted ? 'unknown' : 'none', content: { data: { status: effectStarted ? 'unknown' : 'failed', message: error instanceof Error ? error.message : String(error),
            ...(effectStarted ? { next: 'Read the original page or file receipt before repeating an operation with possible effects.' } : {}) }, parts: [] } } };
      }
    });
  };
  return { capability, prepareConfiguration: settings.prepareConfiguration };
}
