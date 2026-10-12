/** Adapters into the original Run source and Experiment owners for PDF ingestion. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { ThreadResearchSelection } from '@varin/application-client';
import type { DocumentReadRequest } from '@varin/protocol';
import type { DocumentIngestInput } from '../harness/document-reading.js';
import type { DocumentArtifactSource, DocumentMaterialSources } from '../harness/material-read-service.js';
import type { ExperimentService } from '../harness/experiments.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelBlobReadSource, KernelClient, KernelScopedClient } from './kernel-client.js';
import type { LiveSourceResolver } from './live-source.js';
import type { KernelBranchState } from './protocol.generated.js';
import { createResearchAccess, researchCaller } from './research-access.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';

export interface DocumentSources {
  tool(authority: ToolInvocationAuthority): DocumentMaterialSources;
  artifact(selection: ThreadResearchSelection, artifact: NonNullable<DocumentReadRequest['artifact']>, signal?: AbortSignal): Promise<DocumentArtifactSource>;
}

/** Page the original immutable reader rather than imposing a PDF size limit. */
async function sourceBytes(client: KernelScopedClient, state: Extract<KernelBranchState, { kind: 'regular-file' }>,
  source: KernelBlobReadSource, signal?: AbortSignal): Promise<Buffer> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    const page = await client.getBlob(state.objectHash, source, { offset, length: 256 * 1024, signal });
    const bytes = Buffer.from(page.bytesBase64, 'base64');
    if (page.nextOffset !== offset + bytes.byteLength || page.nextOffset > state.byteLength
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
  if (state.kind !== 'regular-file') throw new HarnessServiceError('invalid-params', `The selected document source is a ${state.kind}, not a regular PDF file`);
  return state;
};

export function createDocumentSources(options: {
  kernel: KernelClient;
  runtime: AgentRuntimeClient;
  resolveLiveSource: LiveSourceResolver;
  experiments: Pick<ExperimentService, 'readArtifact'>;
}): DocumentSources {
  const research = createResearchAccess(options.kernel, options.runtime);
  const readPath = async (authority: ToolInvocationAuthority, inputPath: string, signal?: AbortSignal): Promise<DocumentIngestInput> => {
    if (!authority.source) throw new HarnessServiceError('unavailable', 'Select a file source before reading a local document');
    const launch = await options.runtime.launch(authority.runId, signal);
    if (!launch || !isDeepStrictEqual(launch.selection.source, authority.source)) {
      throw new HarnessServiceError('forbidden', 'The document source differs from the original invocation');
    }
    const source = await admitRunSourceAuthority(options.kernel, options.runtime,
      savedSourceLaunch(authority.runId, authority.source, sourceToolSchemas(launch.selection).map(tool => tool.name) as Parameters<typeof savedSourceLaunch>[2]),
      { ...(signal ? { signal } : {}), resolveLiveSource: options.resolveLiveSource });
    let ownerId: string | undefined;
    try {
      signal?.throwIfAborted();
      if (authority.source.mode === 'fixed_branch') {
        const branchId = authority.source.branch_id!, revision = authority.source.revision!;
        const original = await source.client.readBranch({ branchId, revision, paths: [inputPath], includeEntries: true }, signal);
        const entry = original.entries[0];
        const state = regularFile(entry?.state);
        const resourcePath = entry!.path;
        const bytes = await sourceBytes(source.client, state, { branchId, revision, path: resourcePath }, signal);
        return { source: bytes, sourceUrl: `varin-source:///workspaces/${encodeURIComponent(authority.source.workspace_id)}/branches/${encodeURIComponent(branchId)}/revisions/${revision}/${resourcePath.split('/').map(encodeURIComponent).join('/')}`,
          title: path.posix.basename(resourcePath), contentType: 'application/pdf' };
      }
      if (!source.rootId || !source.canonicalRoot) throw new HarnessServiceError('unavailable', 'The original physical document source is unavailable');
      // Single capture uses Storage's original canonical-path/lease owner and retains
      // it through the real worker's stop. It neither follows leaf links nor reads drafts.
      const captured = await source.client.fileCapture({ operationId: `document-source:${authority.operationId}`,
        workspaceId: authority.source.workspace_id, rootId: source.rootId, path: inputPath, store: true }, signal);
      if (typeof captured.ownerId === 'string') ownerId = captured.ownerId;
      if (typeof captured.stateJson !== 'string' || typeof captured.path !== 'string') throw new Error('Document capture returned incomplete provenance');
      const state = regularFile(JSON.parse(captured.stateJson) as KernelBranchState);
      if (!ownerId) throw new Error('Document capture returned no byte owner');
      const bytes = await sourceBytes(source.client, state, { ownerId }, signal);
      return { source: bytes, sourceUrl: pathToFileURL(path.join(source.canonicalRoot, captured.path)).href,
        title: path.posix.basename(captured.path), contentType: 'application/pdf' };
    } finally {
      try { if (ownerId) await source.client.releaseBlob(ownerId); }
      finally { await source.release(); }
    }
  };
  return {
    tool(authority) {
      return { readPath: (path, signal) => readPath(authority, path, signal),
        readArtifact: async (artifact, signal) => {
          const { scope, owner } = await research.toolScope(authority, signal);
          return options.experiments.readArtifact(researchCaller(scope, owner), artifact.attemptId, artifact.artifactId, signal);
        } };
    },
    async artifact(selection, artifact, signal) {
      const scope = await research.selected(selection, signal);
      return options.experiments.readArtifact(researchCaller(scope), artifact.attemptId, artifact.artifactId, signal);
    },
  };
}
