/** Composer candidates are metadata from the admitted Source, never file content or navigation cwd. */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ThreadIdentity, ThreadSource, ThreadSourceFileOptions, ThreadSourceFilePage, ThreadSourceFileEntry, ThreadDraftFileOptions } from '@varin/application-client';
import type { DocumentAuthority } from '../documents/authority.js';
import type { KernelClient } from './kernel-client.js';
import type { KernelComputeOptions, KernelComputeResult } from './compute-runner.js';
import type { KernelComputeService } from './compute-service.js';
import { createSourceQueryOwner, type SourceComputeInput, type SourceQueryAccess } from './source-query.js';
import type { LiveSourceResolver } from './live-source.js';
import { resourceSource } from './thread-context.js';
import { admitMaterializedRoot, originalMaterializationLocation } from './source-launch.js';
import { normalizePathIdentity, normalizeWorkspaceRelativePath } from '../workspace/path-safety.js';
import { SourceAdmissionError } from './source-admission-error.js';

export interface ThreadSourceFilesOwner {
  files(identity: ThreadIdentity, source: ThreadSource, options: ThreadSourceFileOptions, signal?: AbortSignal, runId?: string): Promise<ThreadSourceFilePage>;
  draftFiles(options: ThreadDraftFileOptions, signal?: AbortSignal): Promise<ThreadSourceFilePage>;
}
export function parseThreadSourceFileOptions(value: Record<string, unknown>): ThreadSourceFileOptions {
  if (value.query !== undefined && typeof value.query !== 'string'
    || value.type !== undefined && (typeof value.type !== 'string' || !['file', 'directory', 'all'].includes(value.type))
    || value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1)
    || value.cursor !== undefined && (typeof value.cursor !== 'string' || !value.cursor)) throw new Error('Source file query is malformed');
  return { ...(value.query === undefined ? {} : { query: value.query as string }),
    ...(value.type === undefined ? {} : { type: value.type as NonNullable<ThreadSourceFileOptions['type']> }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }) };
}
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const compare = (a: string, b: string): number => {
  const left = a.split('/'), right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) { const order = Buffer.compare(Buffer.from(left[i]!), Buffer.from(right[i]!)); if (order) return order; }
  return left.length - right.length;
};
type MetadataCompute = (input: SourceComputeInput, options: KernelComputeOptions) => Promise<KernelComputeResult>;

/** Bound response memory, not source coverage. A partial native traversal remains an error;
 * it cannot be confused with a page limit or a complete empty candidate list. */
export async function querySourceFiles(compute: MetadataCompute, scope: unknown, input: ThreadSourceFileOptions = {}, signal?: AbortSignal): Promise<ThreadSourceFilePage> {
  const options = parseThreadSourceFileOptions(input as Record<string, unknown>);
  const query = (options.query ?? '').toLowerCase(), type = options.type ?? 'all', limit = options.limit ?? 50;
  const key = createHash('sha256').update(stable([scope, query, type])).digest('hex');
  let after: string | undefined;
  if (options.cursor) {
    try {
      const cursor: unknown = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error();
      const row = cursor as Record<string, unknown>;
      if (row.key !== key || typeof row.after !== 'string' || !row.after || normalizeWorkspaceRelativePath(row.after) !== row.after) throw new Error();
      after = row.after;
    } catch { throw new Error('Source file continuation changed; restart the query'); }
  }
  const entries: ThreadSourceFileEntry[] = [];
  const seen = new Set<string>();
  const result = await compute({ operation: 'list', lane: 'foreground', paths: [''], query,
    includeHidden: true, respectGitignore: true, includeRevisions: false,
    ...(after === undefined ? {} : { startAfterPath: after }) }, { signal, collect: false, onRecords(records) {
    signal?.throwIfAborted();
    for (const record of records) {
      if (record.kind !== 'entry') continue;
      const metadata = record.data as { kind?: unknown } | null;
      if (!metadata || metadata.kind !== 'file' && metadata.kind !== 'directory') continue;
      const relativePath = normalizeWorkspaceRelativePath(record.path);
      if (!relativePath || relativePath !== record.path) throw new Error('Source file metadata escaped its admitted view');
      if (after !== undefined && compare(relativePath, after) <= 0 || type !== 'all' && metadata.kind !== type
        || !relativePath.toLowerCase().includes(query) || seen.has(relativePath)) continue;
      const entry: ThreadSourceFileEntry = { path: relativePath, relativePath, name: path.posix.basename(relativePath), type: metadata.kind };
      let index = entries.findIndex(item => compare(item.path, relativePath) > 0);
      if (index < 0) index = entries.length;
      if (index > limit) continue;
      entries.splice(index, 0, entry); seen.add(relativePath);
      if (entries.length > limit + 1) seen.delete(entries.pop()!.path);
    }
  } });
  signal?.throwIfAborted();
  if (!['ready', 'empty'].includes(result.status)) throw new Error(result.message ?? 'Source file metadata could not be completely read');
  const hasMore = entries.length > limit;
  if (hasMore) entries.pop();
  return { entries, nextCursor: hasMore ? Buffer.from(JSON.stringify({ key, after: entries.at(-1)!.path })).toString('base64url') : null };
}

export function createThreadSourceFiles(options: {
  kernel: KernelClient;
  documents: Pick<DocumentAuthority, 'resolveWorkspace' | 'admitWorkspaceRegistration' | 'readSnapshot'>;
  validateLiveSource: LiveSourceResolver;
  compute: Pick<KernelComputeService, 'directory'>;
  remote?: ThreadSourceFilesOwner;
}): ThreadSourceFilesOwner {
  return {
    async draftFiles(input, signal) {
      parseThreadSourceFileOptions(input as unknown as Record<string, unknown>);
      if (input.source.resourceOwner.kind === 'managed_host') {
        if (!options.remote) throw new SourceAdmissionError('source_unavailable');
        return options.remote.draftFiles(input, signal);
      }
      signal?.throwIfAborted();
      const resolved = await options.documents.resolveWorkspace({ path: input.source.path });
      const registration = await options.documents.admitWorkspaceRegistration(resolved.workspaceId, signal);
      const result = await querySourceFiles((request, config) => options.compute.directory(registration.canonicalPath, request, config),
        { resourceOwner: input.source.resourceOwner, hostId: resolved.hostId, workspaceId: resolved.workspaceId, root: registration.canonicalPath }, input, signal);
      const current = await options.documents.admitWorkspaceRegistration(resolved.workspaceId, signal);
      if (current.hostId !== registration.hostId || normalizePathIdentity(current.canonicalPath) !== normalizePathIdentity(registration.canonicalPath)) throw new SourceAdmissionError('source_changed');
      signal?.throwIfAborted();
      return result;
    },
    async files(identity, selected, input, signal, runId) {
      if (selected.resourceOwner.kind === 'managed_host') {
        if (!options.remote) throw new SourceAdmissionError('source_unavailable');
        return options.remote.files(identity, selected, input, signal, runId);
      }
      const active = signal ?? new AbortController().signal;
      active.throwIfAborted();
      const source = resourceSource(selected)!;
      // The caller has admitted this exact Thread/Source. Only metadata methods are
      // invoked; an existing materialization also needs the root-registration capability.
      const grant = await options.kernel.issueGrant({ grantId: `source-files:${randomUUID()}`, threadId: identity.threadId,
        owningWorkspace: selected.workspaceId, executionWorkspace: selected.executionWorkspaceId,
        capabilities: ['storage.read', ...(selected.mode === 'materialized' && (selected.environmentRunId || runId) ? ['storage.write'] : [])], pathScopes: [''] }, active);
      const owner = createSourceQueryOwner({ kernel: options.kernel, documents: options.documents, validateLiveSource: options.validateLiveSource,
        targetAuthority: { grant: () => options.kernel.assertGrantForScope(grant) } });
      try {
        const client = options.kernel.scoped(grant);
        let physicalRoot = selected.mode === 'live_root' ? selected.liveRoot : null;
        if (selected.mode === 'native_workspace') {
          if (!options.kernel.nativeWorkspaces) throw new SourceAdmissionError('source_unavailable');
          const native = await options.kernel.nativeWorkspaces.acquire(source, grant, active);
          physicalRoot = { hostId: native.hostId, rootId: native.rootId, canonicalRoot: native.path };
        } else if (selected.mode === 'materialized' && (selected.environmentRunId || runId)) {
          const handshake = options.kernel.handshake ?? await options.kernel.start();
          const location = await originalMaterializationLocation(handshake.storageRoot, selected.workspaceId, selected.environmentRunId ?? runId!);
          if ((await client.getOperation(`source-materialize:${location.key}`, active))?.state === 'committed') {
            const canonicalRoot = await admitMaterializedRoot(location.targetPath, active);
            const root = await client.fileRootRegister({ workspaceId: selected.workspaceId, executionWorkspaceId: selected.executionWorkspaceId, canonicalRoot }, active);
            if (typeof root.rootId !== 'string' || typeof root.canonicalRoot !== 'string' || normalizePathIdentity(root.canonicalRoot) !== normalizePathIdentity(canonicalRoot)) throw new SourceAdmissionError('source_changed');
            physicalRoot = { hostId: handshake.hostId, rootId: root.rootId, canonicalRoot };
          }
        }
        const query: SourceQueryAccess = { threadId: identity.threadId, ...(runId ? { runId } : {}), source, physicalRoot };
        await owner.validate(query, active);
        const result = await querySourceFiles((request, config) => owner.compute(query, request, config), { source, physicalRoot, runId: query.runId ?? null }, input, active);
        await owner.validate(query, active);
        return result;
      } finally {
        await owner.dispose();
        await options.kernel.retireGrant(grant.grantId);
      }
    },
  };
}
