import type { KnowledgeStore } from '../knowledge/store.js';
import type { ExploreDeps } from '../harness/explore.js';

/** Reads the existing catalog only. Indexed relationships are usable when their
 * source revision agrees; every returned code excerpt still comes from Documents. */
export function retrievalGraph(store: KnowledgeStore, roots: string[], read: ExploreDeps['readFile']): NonNullable<ExploreDeps['graph']> {
  const within = (path: string) => roots.some(root => !root || path === root || path.startsWith(`${root}/`));
  const current = async (path: string, revision: string | null) => {
    if (!within(path) || !revision) return false;
    const snapshot = await read(path);
    return snapshot.status === 'ready' && snapshot.revision === revision;
  };
  const sites = async (rows: Awaited<ReturnType<KnowledgeStore['findReferences']>>) =>
    (await Promise.all(rows.map(async row => within(row.path) && await current(row.path, row.documentRevision) ? {
      ...row, ...(row.kind === 'calls' ? { callee: row.value } : {}),
    } : undefined))).filter(row => row !== undefined);
  return {
    catalogStats: async () => {
      const stats = await store.catalogStats();
      return { symbolCount: stats.symbolCount, paths: stats.paths.filter(within) };
    },
    searchDefinitions: async (question, limit) => (await store.searchSymbols(question, limit, roots))
      .map(({ name, path, kind, match }) => ({ name, path, kind, match })),
    findLinks: async value => {
      const results = await store.findLinks(value);
      return (await Promise.all(results.map(async row => await current(row.path, row.documentRevision) ? row : undefined)))
        .filter(row => row !== undefined);
    },
    fileRelations: async path => {
      if (!within(path)) return null;
      const relations = await store.getFileRelations(path);
      if (!relations || !await current(path, relations.documentRevision)) return null;
      return relations;
    },
    findImporters: async path => {
      const results = await store.findImporters(path);
      return { resolved: (await Promise.all(results.resolved.filter(row => within(row.path)).map(async row => {
        const relations = await store.getFileRelations(row.path);
        return relations && await current(row.path, relations.documentRevision) ? row : undefined;
      }))).filter(row => row !== undefined) };
    },
    findReferences: async name => sites(await store.findReferences(name, roots)),
    findCallers: async name => sites(await store.findCallers(name, roots)),
    findCalls: async name => sites(await store.findCalls(name, roots)),
  };
}
