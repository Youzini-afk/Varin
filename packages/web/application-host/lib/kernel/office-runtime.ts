import { OFFICE_CAPABILITY, OFFICE_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { AgentSettingsSnapshot } from '@varin/application-client';
import type { OfficeCreateContent, OfficeEdit, OfficeReadRequest } from '@varin/protocol';
import { compileToolJsonSchema, describeToolSchemaFailure } from '../models/schema.js';
import type { DocumentReaderContext } from '../harness/document-reading.js';
import type { OfficeReader } from '../office/reader.js';
import { OfficePackage } from '../office/package.js';
import { createOfficeFile } from '../office/create.js';
import { OfficeRenderFailure, type OfficeRenderer, type OfficeExportFormat } from '../office/renderer.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { DocumentSources } from './document-sources.js';
import type { createBinaryFileOwner, BinaryFileWriteResult } from './binary-file-owner.js';
import type { LaunchSource } from './protocol.generated.js';
import { runToolDomainCall, type ToolInvocationAuthority } from './tool-invocation.js';
import { threadMaterialScope } from './material-storage.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import { webOutput } from './web-runtime.js';
import { createToolFamilySettings } from './tool-family-settings.js';

export { OFFICE_CAPABILITY };
type WriteInput = { path: string } & (
  | { action: 'create'; content: OfficeCreateContent }
  | { action: 'replace'; expectedRevision: string; content: OfficeCreateContent }
  | { action: 'edit'; expectedRevision: string; edits: OfficeEdit[] }
);
const receipt = (data: unknown, result?: BinaryFileWriteResult): ToolExecutionReceipt => ({
  executor_stopped: result?.executorStopped ?? true,
  completion: { kind: 'result', outcome: result?.status === 'unknown' ? 'indeterminate' : result?.status === 'conflict' ? 'failed' : 'succeeded',
    effect: result?.status === 'applied' ? 'confirmed' : result?.status === 'unknown' ? 'unknown' : 'none', content: { data: parseVarinToolJson(data), parts: [] } },
});
export function createOfficeRuntime(options: {
  runtime: Pick<AgentRuntimeClient, 'run' | 'familyList'>;
  reader: OfficeReader; renderer: OfficeRenderer; sources: DocumentSources; files: ReturnType<typeof createBinaryFileOwner>;
  settings(source: LaunchSource | null): Promise<AgentSettingsSnapshot>;
}) {
  const settings = createToolFamilySettings(OFFICE_TOOL_DECLARATIONS, options.settings);
  const declarations = new Map(OFFICE_TOOL_DECLARATIONS.map(declaration => [declaration.id.slice('varin.office.'.length),
    { declaration, validate: compileToolJsonSchema(declaration.tool!.inputSchema) }]));
  const materialContext = async (invocation: ToolInvocationAuthority, signal: AbortSignal): Promise<DocumentReaderContext> => {
    const run = await options.runtime.run(invocation.runId, signal);
    if (run.thread_id !== invocation.threadId) throw new Error('The original Office invocation changed its Thread');
    const family = await options.runtime.familyList({ callerThreadId: invocation.threadId, includeSelf: true }, signal);
    const workspaceId = threadMaterialScope(family.rootThreadId);
    return { workspaceId, authority: { kind: 'thread', owningWorkspaceId: workspaceId, threadId: invocation.threadId }, signal };
  };
  const capability: HostCapabilityHandler = async (method, value, call) => {
    const selected = declarations.get(method);
    if (!selected) throw new Error('Unknown Office operation');
    if (!selected.validate(value)) throw new Error(`Invalid Office arguments: ${describeToolSchemaFailure(selected.validate, value)}`);
    const input = parseVarinToolJson(value);
    return runToolDomainCall(call, { domain: OFFICE_CAPABILITY, toolName: selected.declaration.tool!.name,
      operation: selected.declaration.tool!.operation, arguments: input }, async invocation => {
      try {
        settings.assertEnabled(invocation.configurationIdentity, invocation.toolName);
        if (method === 'environment') return receipt(await options.renderer.environment());
        const sources = options.sources.tool(invocation);
        if (method === 'write') {
          const request = input as unknown as WriteInput;
          let bytes: Buffer, changes: { changedParts?: string[]; requiresRecalculation?: boolean } = {};
          if (request.action === 'edit') {
            const source = await sources.readPath!(request.path, call.signal);
            const document = new OfficePackage(source.source);
            if (document.revision !== request.expectedRevision) return receipt({ status: 'conflict', path: request.path, revision: document.revision, message: 'The document changed after it was read. Read the current revision before editing.' },
              { status: 'conflict', path: request.path, revision: document.revision, operationId: invocation.operationId, executorStopped: true, fileJournal: true });
            const edited = document.edit(request.edits); bytes = edited.bytes; changes = { changedParts: edited.changedParts, requiresRecalculation: edited.requiresRecalculation };
          } else bytes = await createOfficeFile(request.content, async path => (await sources.readPath!(path, call.signal)).source, call.signal);
          const format = new OfficePackage(bytes).format;
          const written = await options.files.write(invocation, { path: request.path, bytes,
            expectedRevision: request.action === 'create' ? null : request.expectedRevision }, call.signal);
          return receipt({ ...written, ...changes, format }, written);
        }
        const context = await materialContext(invocation, call.signal);
        if (method === 'read') return receipt(await options.reader.read(input as unknown as OfficeReadRequest, context, sources));
        if (method === 'render') {
          const result = await options.reader.render(input as unknown as Parameters<OfficeReader['render']>[0], context, sources);
          return { executor_stopped: true, completion: { kind: 'result', outcome: result.status === 'ok' ? 'succeeded' : 'failed', effect: 'none', content: webOutput(result) } };
        }
        const request = input as unknown as { sourcePath?: string; snapshotId?: string; path: string; expectedRevision?: string; format: OfficeExportFormat };
        if (Number(!!request.sourcePath) + Number(!!request.snapshotId) !== 1) throw new Error('Export requires exactly one sourcePath or snapshotId');
        const original = await options.reader.load({ ...(request.sourcePath ? { path: request.sourcePath } : {}), ...(request.snapshotId ? { snapshotId: request.snapshotId } : {}) }, context, sources);
        const converted = await options.renderer.convert(original.bytes, original.package.format, request.format, call.signal);
        const written = await options.files.write(invocation, { path: request.path, expectedRevision: request.expectedRevision ?? null, bytes: converted.bytes }, call.signal);
        return receipt({ ...written, format: converted.format, engine: converted.engine, recalculated: converted.recalculated }, written);
      } catch (error) {
        const stopped = !(error instanceof OfficeRenderFailure) || error.executorStopped;
        return { executor_stopped: stopped, completion: { kind: 'result', effect: stopped ? 'none' : 'unknown', outcome: !stopped ? 'indeterminate' : call.signal.aborted ? 'cancelled' : 'failed',
          content: { data: { status: stopped ? 'failed' : 'unknown', message: error instanceof Error ? error.message : String(error) }, parts: [] } } };
      }
    });
  };
  return { capability, prepareConfiguration: settings.prepareConfiguration };
}
