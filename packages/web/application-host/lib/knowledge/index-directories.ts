import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { insideDirectory } from './index-scope.js';

export type IndexDirectoryState = 'active' | 'paused' | 'deleting' | 'removed';
export interface IndexDirectoryEntry {
  path: string;
  workspaceId: string;
  state: IndexDirectoryState;
  project: boolean;
  manual: boolean;
  lastCheckedAt?: number;
  error?: string | undefined;
}
export type IndexDirectoryAction = 'add' | 'pause' | 'resume' | 'check' | 'remove';
export interface IndexDirectoryManagerOptions {
  dataDir: string;
  resolve(directory: string): Promise<{ path: string; workspaceId: string }>;
  apply(entries: readonly IndexDirectoryEntry[]): Promise<void>;
  check(entry: IndexDirectoryEntry, signal: AbortSignal): Promise<void>;
  purge(directory: string): Promise<void>;
  cached?(): Promise<Array<{ path: string; workspaceId: string }>>;
  onError?(error: unknown): void;
}

const key = (directory: string) => {
  const normalized = path.resolve(directory);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const revisionOf = (entries: readonly IndexDirectoryEntry[]) => createHash('sha256').update(JSON.stringify(
  entries.map(({ path, workspaceId, state, project, manual }) => ({ path, workspaceId, state, project, manual })),
)).digest('hex');

/** Explicit index ownership. Removed project entries persist as tombstones so
 * restarting the Host cannot silently opt the folder back into indexing. */
export function createIndexDirectoryManager(options: IndexDirectoryManagerOptions) {
  const filename = path.join(options.dataDir, 'index-directories.json');
  let entries: IndexDirectoryEntry[] = [];
  let tail = Promise.resolve();
  let disposed = false;
  const jobs = new Map<string, Promise<void>>();
  const checkControllers = new Map<string, AbortController>();
  const checking = new Set<string>();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const persist = async (next: IndexDirectoryEntry[]): Promise<void> => {
    for (const entry of next) {
      const prior = entries.find((item) => key(item.path) === key(entry.path));
      if (entry.state !== 'active' && prior?.state !== entry.state) checkControllers.get(key(entry.path))?.abort();
    }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await mkdir(options.dataDir, { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, entries: next }, null, 2)}\n`, { flag: 'wx' });
      await rename(temporary, filename);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    entries = next;
    await options.apply(entries);
  };
  const assertRevision = (revision: string): void => {
    if (revision !== revisionOf(entries)) throw new Error('Index directories changed elsewhere; refresh before editing');
  };
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* diagnostics */ } };
  const finishJob = async (directory: string, patch: Partial<IndexDirectoryEntry>, descendants = false) => serialize(async () => {
    await persist(entries.map((entry) => key(entry.path) === key(directory) || (descendants && entry.state === 'deleting' && insideDirectory(directory, entry.path))
      ? { ...entry, ...patch } : entry));
  });
  const startCheck = (entry: IndexDirectoryEntry): void => {
    const id = key(entry.path);
    if (disposed || jobs.has(id)) return;
    checking.add(id);
    const controller = new AbortController();
    checkControllers.set(id, controller);
    let interrupted = false;
    let resolved: { path: string; workspaceId: string } | undefined;
    const task = options.resolve(entry.path).then((value) => {
      controller.signal.throwIfAborted();
      resolved = value;
      return options.check({ ...entry, ...value }, controller.signal);
    }).then(
      () => finishJob(entry.path, { ...resolved, lastCheckedAt: Date.now(), error: undefined }),
      (error: unknown) => {
        // A user pause/removal cancels the accepted scan; do not turn that into
        // a broken-folder error or clear a pending deletion.
        if (error instanceof Error && error.name === 'AbortError') { interrupted = true; return; }
        return finishJob(entry.path, { error: error instanceof Error ? error.message : String(error) });
      },
    ).catch(report).finally(() => {
      checking.delete(id);
      if (checkControllers.get(id) === controller) checkControllers.delete(id);
      if (jobs.get(id) !== task) return;
      jobs.delete(id);
      const current = entries.find((entry) => key(entry.path) === id);
      if (interrupted && current?.state === 'active') startCheck(current);
    });
    jobs.set(id, task);
  };
  const startRemoval = (directory: string): void => {
    const id = key(directory);
    if (disposed) return;
    const preceding = jobs.get(id);
    const task = (async () => {
      await preceding;
      await options.purge(directory);
      await finishJob(directory, { state: 'removed', error: undefined }, true);
    })().catch(async (error: unknown) => {
      await finishJob(directory, { error: error instanceof Error ? error.message : String(error) }, true).catch(report);
    }).finally(() => { if (jobs.get(id) === task) jobs.delete(id); });
    jobs.set(id, task);
  };

  return {
    async load(): Promise<void> {
      let raw: string;
      try { raw = await readFile(filename, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('Invalid index directory catalog');
      entries = parsed.entries.map((item: unknown) => {
        const row = item as Partial<IndexDirectoryEntry>;
        if (!row || typeof row.path !== 'string' || !path.isAbsolute(row.path)
          || typeof row.workspaceId !== 'string' || !['active', 'paused', 'deleting', 'removed'].includes(String(row.state))
          || typeof row.project !== 'boolean' || typeof row.manual !== 'boolean') throw new Error('Invalid index directory entry');
        return row as IndexDirectoryEntry;
      });
      await options.apply(entries);
      for (const entry of entries) {
        if (entry.state === 'active') startCheck(entry);
        else if (entry.state === 'deleting' && !entries.some((parent) => parent !== entry && parent.state === 'deleting' && insideDirectory(parent.path, entry.path))) startRemoval(entry.path);
      }
    },
    snapshot: () => ({ revision: revisionOf(entries), entries: entries.filter((entry) => entry.state !== 'removed')
      .map((entry) => ({ ...entry, checking: checking.has(key(entry.path)), busy: jobs.has(key(entry.path)) })) }),
    list: async () => {
      const current = entries;
      return { revision: revisionOf(current), entries: [
      ...current.filter((entry) => entry.state !== 'removed').map((entry) => ({ ...entry, checking: checking.has(key(entry.path)), busy: jobs.has(key(entry.path)) })),
      ...(await options.cached?.() ?? []).filter((cached) => !current.some((entry) => key(entry.path) === key(cached.path)))
        .map((cached) => ({ ...cached, state: 'paused' as const, project: false, manual: false, checking: false, busy: false, cacheOnly: true })),
    ] }; },
    allEntries: () => entries,
    syncProjects: (directories: readonly string[]) => serialize(async () => {
      if (disposed) return;
      const selected = new Set(directories.map(key));
      const next = entries.map((entry) => ({ ...entry, project: selected.has(key(entry.path)),
        state: entry.project && !selected.has(key(entry.path)) && !entry.manual ? 'deleting' as const : entry.state }));
      for (const directory of directories) {
        const existing = next.find((entry) => key(entry.path) === key(directory));
        if (existing) continue;
        try {
          const resolved = await options.resolve(directory);
          if (!next.some((entry) => key(entry.path) === key(resolved.path))) next.push({ ...resolved, state: 'active', project: true, manual: false });
        } catch (error) {
          // Disconnected drives and moved folders remain editable entries;
          // they must not prevent the application or other projects starting.
          next.push({ path: directory, workspaceId: '', state: 'active', project: true, manual: false,
            error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (JSON.stringify(next) === JSON.stringify(entries)) return;
      await persist(next);
      for (const entry of next) {
        if (entry.state === 'active') startCheck(entry);
        else if (entry.state === 'deleting' && !jobs.has(key(entry.path))) startRemoval(entry.path);
      }
    }),
    act: (action: IndexDirectoryAction, directory: string, revision: string) => serialize(async () => {
      assertRevision(revision);
      if (disposed) throw new Error('Index directory manager is closed');
      if (action === 'add') {
        const resolved = await options.resolve(directory);
        const previous = entries.find((entry) => key(entry.path) === key(resolved.path));
        if (previous?.state === 'deleting') throw new Error('This index is still being deleted');
        const entry: IndexDirectoryEntry = { ...previous, ...resolved, state: 'active', project: previous?.project ?? false, manual: true, error: undefined };
        await persist([...entries.filter((item) => key(item.path) !== key(entry.path)), entry]);
        startCheck(entry);
        return;
      }
      let entry = entries.find((item) => key(item.path) === key(directory) && item.state !== 'removed');
      if (!entry) {
        const cached = (await options.cached?.() ?? []).find((item) => key(item.path) === key(directory));
        if (cached) {
          // Existing derived caches remain manageable without admitting them
          // to background indexing. Removal also works if the source is gone.
          const resolved = action === 'remove' ? cached : await options.resolve(cached.path);
          entry = { ...resolved, state: action === 'remove' ? 'deleting' : 'paused', project: false, manual: action !== 'remove' };
          await persist([...entries.filter((item) => key(item.path) !== key(directory)), entry]);
        }
      }
      if (!entry) throw new Error('Index directory no longer exists');
      if (entry.state === 'deleting' && action !== 'remove') throw new Error('This index is still being deleted');
      if (action === 'check') { startCheck(entry); return; }
      if (action === 'remove') {
        if (entry.state === 'deleting' && jobs.has(key(entry.path))) return;
        await persist(entries.map((item) => insideDirectory(entry.path, item.path) ? { ...item, state: 'deleting', error: undefined } : item));
        startRemoval(entry.path);
        return;
      }
      const updated = { ...entry, state: action === 'pause' ? 'paused' as const : 'active' as const, error: undefined };
      await persist(entries.map((item) => item === entry ? updated : item));
      if (action === 'resume') startCheck(updated);
    }),
    drain: async () => { await tail; while (jobs.size) await Promise.allSettled([...jobs.values()]); },
    dispose: async () => {
      disposed = true;
      for (const controller of checkControllers.values()) controller.abort();
      await tail;
      await Promise.allSettled([...jobs.values()]);
    },
  };
}
