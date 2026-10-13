import { createHash } from 'node:crypto';
import type { RetrievalQuery } from './protocol.generated.js';
import { createSourceQueryOwner, type SourceQueryOwner } from './source-query.js';
import { FILE_SEARCH_EXCLUDED_DIRECTORIES } from '../fs/search.js';
import type { SemanticSourceView } from '../knowledge/semantic/query-view.js';

export interface RetrievalSourceOwner extends SourceQueryOwner {
  semanticView(query: RetrievalQuery, signal: AbortSignal): Promise<SemanticSourceView>;
}
export function createRetrievalSourceOwner(options: Parameters<typeof createSourceQueryOwner>[0]): RetrievalSourceOwner {
  const source = createSourceQueryOwner(options);
  const { validate, compute } = source;
  return {
    ...source,
    async semanticView(query, signal) {
      await validate(query, signal);
      if (query.source.mode === 'live_root' && query.source.resource_owner.kind === 'local') throw new Error('Live retrieval uses its original published source');
      const mode = query.source.mode;
      const resourceOwner = query.source.resource_owner;
      const resourceRoot = await source.routingWorkspace(query, signal);
      const configurationRoot = resourceOwner.kind === 'local' ? resourceRoot : '';
      const cacheWorkspaceId = resourceOwner.kind === 'local' ? query.source.workspace_id
        : `managed-source:${createHash('sha256').update(JSON.stringify([resourceOwner.hostId,
          resourceOwner.connectionId, resourceOwner.endpointIdentity, query.source.workspace_id])).digest('hex')}`;
      const inventory = async (roots: readonly string[], active: AbortSignal,
        expected?: readonly { path: string; revision: string }[], respectGitignore = true) => {
        await validate(query, active);
        const files: Array<{ path: string; revision: string }> = [];
        const result = await compute(query, { operation: 'list', lane: 'foreground', paths: [...roots],
          includeHidden: true, includeTracked: true, respectGitignore: expected ? false : respectGitignore,
          excludeDirectories: expected ? [] : FILE_SEARCH_EXCLUDED_DIRECTORIES, includeRevisions: mode !== 'fixed_branch',
          ...(expected ? { files: expected.map(file => ({ path: file.path })) } : {}) },
        { signal: active, collect: false, onRecords(records) {
          for (const record of records) {
            if (record.kind !== 'entry' || !record.data || typeof record.data !== 'object'
              || !('kind' in record.data) || record.data.kind !== 'file') continue;
            if (!record.path || !record.revision) throw new Error('Source inventory returned no file version');
            files.push({ path: record.path, revision: record.revision });
          }
        } });
        if (result.status === 'failed' || result.status === 'cancelled') throw new Error('Source inventory did not complete');
        await validate(query, active);
        return { files, complete: result.status !== 'partial' };
      };
      return {
        mode, resourceOwner, resourceRoot, configurationRoot, cacheWorkspaceId,
        ...(resourceOwner.kind === 'managed_host' ? { structure: {
          async unitsRecipe(request) {
            if (!options.remote) throw new Error('The original source structure service is unavailable');
            const result = await options.remote.service(query, { kind: 'structure_recipe', path: request.path, languageId: request.languageId }, signal);
            return result.recipeId === null ? undefined : result.recipeId;
          },
          async unitsFixed(request) {
            if (!options.remote) throw new Error('The original source structure service is unavailable');
            return options.remote.service(query, { kind: 'structure_units', path: request.path, languageId: request.languageId }, request.signal ?? signal);
          },
        } satisfies NonNullable<SemanticSourceView['structure']> } : {}),
        listFiles: (roots, active, options) => inventory(roots, active, undefined, options?.respectGitignore ?? true),
        compute: (input, options) => compute(query, input, options),
        async validateDocuments(expected, active) {
          if (!expected.length) { await validate(query, active); return; }
          const observed = await inventory(expected.map(file => file.path), active, expected);
          const revisions = new Map(observed.files.map(file => [file.path, file.revision]));
          if (!observed.complete || expected.some(file => revisions.get(file.path) !== file.revision)) {
            throw new Error('Source content changed before semantic inference');
          }
        },
      };
    },
  };
}
