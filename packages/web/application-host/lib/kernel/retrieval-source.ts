import type { RetrievalQuery } from './protocol.generated.js';
import { createSourceQueryOwner, type SourceQueryOwner } from './source-query.js';
import { FILE_SEARCH_EXCLUDED_DIRECTORIES } from '../fs/search.js';
import type { SemanticSourceView } from '../knowledge/semantic/query-view.js';

export interface RetrievalSourceOwner extends SourceQueryOwner {
  semanticView(query: RetrievalQuery, signal: AbortSignal): Promise<SemanticSourceView>;
}
export function createRetrievalSourceOwner(options: Parameters<typeof createSourceQueryOwner>[0]): RetrievalSourceOwner {
  const { documents } = options;
  const source = createSourceQueryOwner(options);
  const { validate, compute } = source;
  return {
    ...source,
    async semanticView(query, signal) {
      await validate(query, signal);
      if (query.source.mode === 'live_root') throw new Error('Live retrieval uses its original published source');
      const mode = query.source.mode;
      const registration = await documents.admitWorkspaceRegistration(query.source.workspace_id, signal);
      const inventory = async (roots: readonly string[], active: AbortSignal,
        expected?: readonly { path: string; revision: string }[], respectGitignore = true) => {
        await validate(query, active);
        const files: Array<{ path: string; revision: string }> = [];
        const result = await compute(query, { operation: 'list', lane: 'foreground', paths: [...roots],
          includeHidden: true, includeTracked: true, respectGitignore: expected ? false : respectGitignore,
          excludeDirectories: expected ? [] : FILE_SEARCH_EXCLUDED_DIRECTORIES, includeRevisions: mode === 'materialized',
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
        mode, configurationRoot: registration.canonicalPath,
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
