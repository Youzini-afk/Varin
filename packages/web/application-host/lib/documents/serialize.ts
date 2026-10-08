import { waitWithSignal } from '../cancellation.js';

export const createSerialQueues = () => {
  const queues = new Map<string, Promise<unknown>>();
  const scoped = new Set<{
    resources: readonly SerialQueueResource[];
    completion: Promise<unknown>;
  }>();

  const run = <Result>(key: string, work: () => Promise<Result>): Promise<Result> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }).catch(() => undefined);
    return next as Promise<Result>;
  };

  const runMany = <Result>(keys: readonly string[], work: () => Promise<Result>): Promise<Result> => {
    const unique = [...new Set(keys)].sort();
    const execute = async (): Promise<Result> => work();
    return unique.reduceRight(
      (nested: () => Promise<Result>, key: string) => () => run(key, nested),
      execute,
    )();
  };

  const runResources = <Result>(
    resources: readonly SerialQueueResource[],
    work: () => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result> => {
    const normalized = [...new Map(resources.map((resource) => [
      resource.key,
      {
        key: resource.key,
        scope: resources.some((candidate) => candidate.key === resource.key && candidate.scope === 'subtree')
          ? 'subtree' as const
          : 'exact' as const,
      },
    ])).values()];
    const blockers = [...scoped]
      .filter((entry) => entry.resources.some((active) => normalized.some((requested) => resourcesOverlap(active, requested))))
      .map((entry) => entry.completion.catch(() => undefined));
    // Cancellation removes a waiting entry, but an operation that already
    // owns the resources keeps them until its work actually settles.
    const completion = waitWithSignal(Promise.all(blockers), signal).then(() => {
      signal?.throwIfAborted();
      return work();
    });
    const entry = { resources: normalized, completion: completion as Promise<unknown> };
    scoped.add(entry);
    void completion.finally(() => scoped.delete(entry)).catch(() => undefined);
    return completion;
  };

  return { run, runMany, runResources };
};

export interface SerialQueueResource {
  key: string;
  scope: 'exact' | 'subtree';
}

const containsPath = (parent: string, child: string): boolean => (
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
);

const resourcesOverlap = (left: SerialQueueResource, right: SerialQueueResource): boolean => (
  left.key === right.key
  || (left.scope === 'subtree' && containsPath(left.key, right.key))
  || (right.scope === 'subtree' && containsPath(right.key, left.key))
);
