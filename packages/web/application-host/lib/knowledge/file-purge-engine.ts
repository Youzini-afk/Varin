import type { FilePurgePort, FilePurgeProgress, FilePurgeScope } from './file-purge.js';
import { pathInRoots } from '../workspace/path-scope.js';

interface Database {
  nodeCount(): number;
  indexedLookup(query: Record<string, unknown>, limit: number): number[];
  getPayload(id: number): unknown;
  commitTransaction(operations: Array<{ type: 'delete'; id: number }>): unknown;
}
type Row = { id: number; type: string };

export function createFilePurgeEngine(options: {
  db: Database;
  enqueue<T>(work: () => T): Promise<T>;
  recordBatchSize: number;
  changed(): void;
}): FilePurgePort & { clear(): void } {
  const jobs = new Map<number, {
    scope: FilePurgeScope; files: Row[]; records: Row[]; offset: number;
    phase: FilePurgeProgress['phase']; removedNodes: number;
  }>();
  let next = 0;
  const payload = (id: number) => options.db.getPayload(id) as Record<string, unknown> | null;
  const contains = (path: string, scope: FilePurgeScope): boolean => scope.roots.length > 0
    && pathInRoots(path, scope.roots) && !(scope.preservedRoots?.length && pathInRoots(path, scope.preservedRoots));
  const selected = (value: Record<string, unknown>, scope: FilePurgeScope): boolean =>
    typeof value['path'] === 'string' && contains(value['path'], scope)
    || value['type'] === 'link' && (value['kind'] === 'calls' || value['kind'] === 'references')
      && typeof value['targetPath'] === 'string' && contains(value['targetPath'], scope);
  return {
    beginFilePurge: input => options.enqueue(() => {
      if (!input || !Array.isArray(input.roots) || (input.preservedRoots !== undefined && !Array.isArray(input.preservedRoots))
        || [...input.roots, ...(input.preservedRoots ?? [])].some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid file purge scope');
      const scope = { roots: [...input.roots], preservedRoots: [...(input.preservedRoots ?? [])] };
      const files: Row[] = []; const records: Row[] = [];
      const limit = Math.max(1, options.db.nodeCount());
      // Read each type once, rather than intersecting the whole type posting
      // list again for every source file. No plan, event or memory row is selected.
      for (const type of scope.roots.length ? ['file', 'symbol', 'link'] : []) {
        for (const id of options.db.indexedLookup({ type }, limit)) {
          const value = payload(id);
          if (!value || !selected(value, scope)) continue;
          const row = { id, type };
          (type === 'file' ? files : records).push(row);
        }
      }
      // Delete source owners first. Native deletion then removes all of that
      // file's outgoing edges together, instead of scanning the global label
      // posting list separately for each of its symbols and relation rows.
      // Native property/ngram postings are sorted Vec<NodeId>s: removing low
      // IDs first repeatedly shifts their entire remaining tail. Descending
      // IDs avoid that quadratic copy cost when clearing a source catalog.
      files.sort((a, b) => b.id - a.id);
      records.sort((a, b) => b.id - a.id);
      const id = ++next;
      jobs.set(id, { scope, files, records, offset: 0, phase: 'files', removedNodes: 0 });
      return id;
    }),
    stepFilePurge: id => options.enqueue(() => {
      const job = jobs.get(id);
      if (!job) throw new Error('File purge is no longer open');
      if (job.phase === 'files' && job.offset === job.files.length) { job.phase = 'records'; job.offset = 0; }
      const rows = job.phase === 'files' ? job.files : job.records;
      // File owners carry edges and use a short turn. Once those edges are
      // gone, ordinary rows use the existing retention deletion quantum.
      // Neither scheduling quantum limits the amount of removable index data.
      const end = Math.min(rows.length, job.offset + (job.phase === 'files' ? 64 : options.recordBatchSize));
      const ids = rows.slice(job.offset, end).flatMap(row => {
        const value = payload(row.id);
        return value?.['type'] === row.type && selected(value, job.scope) ? [row.id] : [];
      });
      if (ids.length) {
        options.db.commitTransaction(ids.map(id => ({ type: 'delete', id })));
        job.removedNodes += ids.length;
        options.changed();
      }
      job.offset = end;
      return { phase: job.phase, completed: end, total: rows.length, removedNodes: job.removedNodes,
        done: job.phase === 'records' && end === rows.length };
    }),
    releaseFilePurge: async id => { jobs.delete(id); },
    clear: () => { jobs.clear(); },
  };
}
