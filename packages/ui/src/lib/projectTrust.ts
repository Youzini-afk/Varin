import { runtimeFetch, getRuntimeEndpointGeneration } from '@varin/application-client';
import { subscribeVarinEvents } from '@/lib/varinEvents';

export interface ProjectTrust {
  workspaceId: string;
  path: string;
  decision: boolean | null;
  directDecision: boolean | null;
  revision: string;
}

let generation = 0;
const listeners = new Set<() => void>();
let stopEvents: (() => void) | undefined;
export const getProjectTrustGeneration = (): number => generation;
const invalidate = (): void => {
  generation += 1;
  for (const listener of listeners) listener();
};

/** An invalidation is not a new trust grant. Every consumer must read its original owner again. */
export function subscribeProjectTrustChanges(listener: () => void): () => void {
  listeners.add(listener);
  stopEvents ??= subscribeVarinEvents(event => {
    if (event.type === 'stream-ready' || event.type === 'settings-changed'
      && event.owner === 'agent-settings' && event.ids.includes('project-trust')) invalidate();
  });
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stopEvents?.(); stopEvents = undefined; }
  };
}

function decode(value: unknown, workspaceId: string): ProjectTrust {
  const entry = value as Partial<ProjectTrust> | null;
  if (!entry || entry.workspaceId !== workspaceId || typeof entry.path !== 'string' || !entry.path
    || typeof entry.revision !== 'string' || !entry.revision
    || ![true, false, null].includes(entry.decision as boolean | null)
    || ![true, false, null].includes(entry.directDecision as boolean | null)) throw new Error('Invalid project trust response');
  return entry as ProjectTrust;
}

async function request(action: 'read' | 'update', workspaceId: string, body: object, owner: number, signal?: AbortSignal): Promise<ProjectTrust> {
  const check = () => {
    signal?.throwIfAborted();
    if (owner !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed. Review project trust again.');
  };
  check();
  const response = await runtimeFetch(`/api/project-trust/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, ...body }), signal,
  });
  check();
  const result: unknown = await response.json();
  check();
  if (!response.ok) {
    const failure = result as { message?: string; error?: string } | null;
    throw new Error(failure?.message ?? failure?.error ?? 'Project trust is unavailable');
  }
  return decode(result, workspaceId);
}

export async function readProjectTrust(workspaceId: string, signal?: AbortSignal): Promise<ProjectTrust> {
  const observed = generation;
  const result = await request('read', workspaceId, {}, getRuntimeEndpointGeneration(), signal);
  if (observed !== generation) throw new Error('Project trust changed while reading. Reload and try again.');
  return result;
}

/** Confirmation is asynchronous and scoped to the exact Host, project, revision and mounted caller. */
export async function changeProjectTrust(
  snapshot: ProjectTrust,
  decision: boolean | null,
  options: { confirm: () => Promise<boolean>; isCurrent: () => boolean; signal?: AbortSignal },
): Promise<ProjectTrust | null> {
  const owner = getRuntimeEndpointGeneration();
  const observed = generation;
  const current = () => owner === getRuntimeEndpointGeneration() && observed === generation
    && !options.signal?.aborted && options.isCurrent();
  if (!current() || !await options.confirm() || !current()) return null;
  // Once sent, cancellation only stops observation. It cannot promise to undo a saved decision.
  try {
    const result = await request('update', snapshot.workspaceId, {
      expectedPath: snapshot.path, expectedRevision: snapshot.revision, decision,
    }, owner, options.signal);
    return current() ? result : null;
  } finally {
    // A lost response may still have committed. Retire cached grants even on failure.
    if (owner === getRuntimeEndpointGeneration()) invalidate();
  }
}
