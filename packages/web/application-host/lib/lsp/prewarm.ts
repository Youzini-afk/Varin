import type { DocumentAuthority } from '../documents/authority.js';
import type { LanguageSupportRuntime } from '../language-support/runtime.js';
import { createLanguageViewBinder } from './language-view.js';
import type { createLanguageSupervisor } from './supervisor.js';

/** Project and session owners share the same startup used by real queries. */
export function createLanguagePrewarm(options: {
  documents: DocumentAuthority;
  languages: LanguageSupportRuntime;
  supervisor: ReturnType<typeof createLanguageSupervisor>;
  onError(error: unknown): void;
}) {
  const owners = new Map<string, string>();
  const workspaces = new Map<string, { owners: Set<string>; controller: AbortController; release(): void; done: Promise<void> }>();
  const pending = new Set<Promise<void>>();
  const binder = createLanguageViewBinder(options);
  let disposed = false;

  const releaseOwner = (owner: string): void => {
    const workspaceId = owners.get(owner);
    if (!workspaceId) return;
    owners.delete(owner);
    const entry = workspaces.get(workspaceId);
    entry?.owners.delete(owner);
    if (!entry || entry.owners.size) return;
    workspaces.delete(workspaceId);
    entry.controller.abort();
    entry.release();
  };

  const setWorkspace = (owner: string, workspaceId: string | null, refresh = false): void => {
    if (disposed || owners.get(owner) === workspaceId) return;
    releaseOwner(owner);
    if (!workspaceId) return;
    owners.set(owner, workspaceId);
    const existing = workspaces.get(workspaceId);
    if (existing) { existing.owners.add(owner); return; }
    const controller = new AbortController();
    const release = options.supervisor.retainWorkspace(workspaceId);
    const done = (async () => {
      const samples = await options.languages.warmupDocuments(workspaceId, controller.signal, refresh);
      await Promise.all(samples.map(async sample => {
        try {
          const started = await options.supervisor.prewarm(workspaceId, sample.languageId, controller.signal);
          if (started.every(record => record === null)) return;
          const failed = started.find(record => record?.status === 'failed');
          if (failed) throw new Error(failed.message);
          controller.signal.throwIfAborted();
          // Opening one real source file lets lazy project servers load their
          // project, while the editor view keeps ownership of its own buffers.
          const bound = await binder.bind({ workspaceId, ...sample, text: 'disk', signal: controller.signal });
          if (bound.status !== 'bound') throw new Error(bound.message);
        } catch (error) { if (!controller.signal.aborted) options.onError(error); }
      }));
    })().catch(error => { if (!controller.signal.aborted) options.onError(error); });
    workspaces.set(workspaceId, { owners: new Set([owner]), controller, release, done });
    pending.add(done);
    void done.finally(() => pending.delete(done));
  };

  return {
    setWorkspace,
    releaseOwner,
    refreshWorkspace(workspaceId: string) {
      const affected = [...(workspaces.get(workspaceId)?.owners ?? [])];
      for (const owner of affected) releaseOwner(owner);
      for (const owner of affected) setWorkspace(owner, workspaceId, true);
    },
    async dispose() {
      disposed = true;
      for (const owner of [...owners.keys()]) releaseOwner(owner);
      await Promise.allSettled([...pending]);
    },
  };
}
