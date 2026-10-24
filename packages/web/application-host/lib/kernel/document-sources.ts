/** Adapters into the original Run source and Experiment owners for PDF ingestion. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { ThreadResearchSelection } from '@varin/application-client';
import type { DocumentReadRequest } from '@varin/protocol';
import type { DocumentIngestInput } from '../harness/document-reading.js';
import type { DocumentArtifactSource, DocumentMaterialSources } from '../harness/document-material.js';
import type { ExperimentService } from '../harness/experiments.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelBlobReadSource, KernelClient, KernelScopedClient } from './kernel-client.js';
import type { LiveSourceResolver } from './live-source.js';
import { resourceThreadSource } from './thread-context.js';
import type { LaunchSource, LiveRoot, KernelBranchState } from './protocol.generated.js';
import { createResearchAccess, researchCaller } from './research-access.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';

const contentType = (filename: string): string => ({
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}[path.extname(filename).toLowerCase()] ?? 'application/octet-stream');

export interface DocumentSources {
  tool(authority: ToolInvocationAuthority): DocumentMaterialSources;
  path(selection: ThreadResearchSelection, path: string, signal?: AbortSignal): Promise<DocumentIngestInput>;
  artifact(selection: ThreadResearchSelection, artifact: NonNullable<DocumentReadRequest['artifact']>, signal?: AbortSignal): Promise<DocumentArtifactSource>;
}

/** Page the original immutable reader rather than imposing a PDF size limit. */
async function sourceBytes(client: Pick<KernelScopedClient, 'getBlob'>, state: Extract<KernelBranchState, { kind: 'regular-file' }>,
  source: KernelBlobReadSource, signal?: AbortSignal): Promise<Buffer> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    const page = await client.getBlob(state.objectHash, source, { offset, length: 256 * 1024, signal });
    const bytes = Buffer.from(page.bytesBase64, 'base64');
    if (page.offset !== offset || page.hash !== state.objectHash || page.byteLength !== state.byteLength
      || page.nextOffset !== offset + bytes.byteLength || page.nextOffset > state.byteLength
      || page.eof !== (page.nextOffset === state.byteLength) || !page.eof && page.nextOffset <= offset) {
      throw new HarnessServiceError('unavailable', 'The original document bytes are incomplete');
    }
    parts.push(bytes);
    if (page.eof) return Buffer.concat(parts);
    offset = page.nextOffset;
  }
}

const regularFile = (state: KernelBranchState | undefined): Extract<KernelBranchState, { kind: 'regular-file' }> => {
  if (!state || state.kind === 'missing') throw new HarnessServiceError('not-found', 'The document is missing from its original source');
  if (state.kind !== 'regular-file') throw new HarnessServiceError('invalid-params', `The selected document source is a ${state.kind}, not a regular file`);
  return state;
};

/** Shared local/target reader. A target object hash remains solely inside its native owner. */
export async function readSourceDocument(input: {
  client: Pick<KernelScopedClient, 'readBranch' | 'fileCapture' | 'getBlob' | 'releaseBlob'>; source: LaunchSource; physicalRoot: LiveRoot | null;
  operationId: string; path: string; signal?: AbortSignal;
}): Promise<DocumentIngestInput> {
  const { client, source, physicalRoot, signal } = input;
  const hostPrefix = source.resource_owner.kind === 'managed_host' ? `/hosts/${encodeURIComponent(source.resource_owner.hostId)}` : '';
  const provenance = `varin-source://${hostPrefix}/workspaces/${encodeURIComponent(source.workspace_id)}`;
  let ownerId: string | undefined;
  try {
    signal?.throwIfAborted();
    if (source.mode === 'fixed_branch') {
      const branchId = source.branch_id!, revision = source.revision!;
      const original = await client.readBranch({ branchId, revision, paths: [input.path], includeEntries: true }, signal);
      const entry = original.entries[0];
      const state = regularFile(entry?.state), resourcePath = entry!.path;
      const bytes = await sourceBytes(client, state, { branchId, revision, path: resourcePath }, signal);
      return { source: bytes, sourceUrl: `${provenance}/branches/${encodeURIComponent(branchId)}/revisions/${revision}/${resourcePath.split('/').map(encodeURIComponent).join('/')}`,
        title: path.posix.basename(resourcePath), contentType: contentType(resourcePath) };
    }
    if (!physicalRoot) throw new HarnessServiceError('unavailable', 'The original physical document source is unavailable');
    const captured = await client.fileCapture({ operationId: `document-source:${input.operationId}`,
      workspaceId: source.workspace_id, rootId: physicalRoot.rootId, path: input.path, store: true }, signal);
    if (typeof captured.ownerId === 'string') ownerId = captured.ownerId;
    if (typeof captured.stateJson !== 'string' || typeof captured.path !== 'string') throw new Error('Document capture returned incomplete provenance');
    const state = regularFile(JSON.parse(captured.stateJson) as KernelBranchState);
    if (!ownerId) throw new Error('Document capture returned no byte owner');
    const bytes = await sourceBytes(client, state, { ownerId }, signal);
    return { source: bytes, sourceUrl: source.resource_owner.kind === 'managed_host'
      ? `${provenance}/roots/${encodeURIComponent(physicalRoot.rootId)}/${captured.path.split('/').map(encodeURIComponent).join('/')}`
      : pathToFileURL(path.join(physicalRoot.canonicalRoot, captured.path)).href,
      title: path.posix.basename(captured.path), contentType: contentType(captured.path) };
  } finally { if (ownerId) await client.releaseBlob(ownerId); }
}

export function createDocumentSources(options: {
  kernel: KernelClient;
  runtime: AgentRuntimeClient;
  resolveLiveSource: LiveSourceResolver;
  experiments: Pick<ExperimentService, 'readArtifact'>;
}): DocumentSources {
  const research = createResearchAccess(options.kernel, options.runtime);
  const readPath = async (authority: Pick<ToolInvocationAuthority, 'source' | 'runId' | 'operationId'>, inputPath: string, signal?: AbortSignal): Promise<DocumentIngestInput> => {
    if (!authority.source) throw new HarnessServiceError('unavailable', 'Select a file source before reading a local document');
    const launch = await options.runtime.launch(authority.runId, signal);
    if (!launch || !isDeepStrictEqual(launch.selection.source, authority.source)) {
      throw new HarnessServiceError('forbidden', 'The document source differs from the original invocation');
    }
    if (authority.source.resource_owner.kind === 'managed_host') {
      return options.runtime.withManagedSourceAuthority(authority.runId, resourceThreadSource(authority.source)!, async ({ client, binding }) => {
        const document = await client.service({ coordinatorHostId: options.runtime.coordinatorHostId,
          authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, requestId: `document-read:${randomUUID()}`,
          operation: { kind: 'document_read', operationId: authority.operationId, path: inputPath } }, signal);
        signal?.throwIfAborted();
        const bytes = Buffer.from(document.bytesBase64, 'base64');
        if (bytes.byteLength !== document.byteLength) throw new HarnessServiceError('unavailable', 'The original document bytes are incomplete');
        return { source: bytes, sourceUrl: document.sourceUrl, title: document.title, contentType: document.contentType };
      }, signal);
    }
    const source = await admitRunSourceAuthority(options.kernel, options.runtime,
      savedSourceLaunch(authority.runId, authority.source, sourceToolSchemas(launch.selection).map(tool => tool.name)),
      { ...(signal ? { signal } : {}), resolveLiveSource: options.resolveLiveSource });
    try {
      if (source.kind !== 'local') throw new HarnessServiceError('forbidden', 'The document resource owner changed');
      return await readSourceDocument({ client: source.client, source: authority.source, operationId: authority.operationId,
        physicalRoot: source.rootId && source.canonicalRoot ? { hostId: source.toolBinding.liveRoot?.hostId ?? options.kernel.handshake!.hostId,
          rootId: source.rootId, canonicalRoot: source.canonicalRoot } : null, path: inputPath, ...(signal ? { signal } : {}) });
    } finally { await source.release(); }

  };
  return {
    tool(authority) {
      return { readPath: (path, signal) => readPath(authority, path, signal),
        readArtifact: async (artifact, signal) => {
          const { scope, owner } = await research.toolScope(authority, signal);
          return options.experiments.readArtifact(researchCaller(scope, owner), artifact.attemptId, artifact.artifactId, signal);
        } };
    },
    async path(selection, path, signal) {
      const scope = await research.selected(selection, signal);
      return readPath({ runId: scope.sourceRunId, source: scope.source, operationId: `document-reader:${randomUUID()}` }, path, signal);
    },
    async artifact(selection, artifact, signal) {
      const scope = await research.selected(selection, signal);
      return options.experiments.readArtifact(researchCaller(scope), artifact.attemptId, artifact.artifactId, signal);
    },
  };
}
