/** Private single-owner checkpoint scheduling. A batch is a shared durability
 * boundary, not a transaction: it never claims to roll back applied mutations. */
export function createStorePersistence(options: {
  flush(): void;
  close(): void;
  enqueue(work: () => void): Promise<unknown>;
  onError(error: unknown): void;
  quietMs?: number;
  maxDeferMs?: number;
  /** Explicit commits follow native WAL fsync; deferred derived writes may lag. */
  walCommits?: boolean;
}) {
  const quietMs = options.quietMs ?? 250;
  const maxDeferMs = options.maxDeferMs ?? 30_000;
  let version = 0;
  let durableVersion = 0;
  let acknowledgedVersion = 0;
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let batchActive = false;
  let commitRequested = false;
  let failed = false;
  let retries = 0;
  let closed = false;
  const notifications: Array<() => void> = [];

  const cancelTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const assertOpen = (): void => {
    if (closed) throw new Error("Knowledge store is closed");
  };
  const publish = (): void => {
    for (const notify of notifications.splice(0)) {
      // Observers cannot turn an already durable write into a reported failure.
      try { notify(); } catch { /* observational */ }
    }
  };
  const schedule = (delay: number): void => {
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      void options.enqueue(() => {
        if (closed) return;
        if (batchActive) { commitRequested = true; return; }
        checkpoint();
      }).catch((error: unknown) => {
        try { options.onError(error); } catch { /* observational */ }
      });
    }, delay);
    timer.unref?.();
  };
  function checkpoint(): void {
    assertOpen();
    cancelTimer();
    if (version === durableVersion && !failed) {
      deadline = 0;
      commitRequested = false;
      publish();
      return;
    }
    const target = version;
    try {
      options.flush();
    } catch (error) {
      // Never clear dirty state before the native checkpoint succeeds. Retrying
      // persists the already-applied state; it must not replay business writes.
      failed = true;
      retries += 1;
      schedule(Math.min(maxDeferMs, quietMs * 2 ** Math.min(retries, 10)));
      throw error;
    }
    durableVersion = target;
    acknowledgedVersion = target;
    failed = false;
    retries = 0;
    deadline = 0;
    commitRequested = false;
    publish();
  }

  function defer(optionsForDefer?: { busy?: boolean }): void {
    assertOpen();
    if (version === durableVersion) return;
    const now = Date.now();
    if (deadline === 0) deadline = now + maxDeferMs;
    // Full-sync commits need no immediate snapshot. Keep derived writes on the
    // same checkpoint deadline, outside the calling operation.
    if (options.walCommits) { schedule(Math.max(0, deadline - now)); return; }
    if (now >= deadline) {
      if (batchActive) commitRequested = true;
      else checkpoint();
      return;
    }
    schedule(optionsForDefer?.busy ? deadline - now : Math.min(quietMs, deadline - now));
  }

  function commitChanges(): void {
    if (!options.walCommits || failed) { checkpoint(); return; }
    acknowledgedVersion = version;
    commitRequested = false;
    publish();
    defer();
  }

  return {
    assertOpen,
    changed(): void { assertOpen(); version += 1; },
    mutationFailed(): void { failed = true; commitRequested = true; },
    /** A previous failed checkpoint must be retried before admitting another
     * request, including a deduplicated write or a read of the in-memory state. */
    recover(): void { assertOpen(); if (failed) checkpoint(); },
    commit(): void {
      assertOpen();
      if (batchActive) commitRequested = true;
      else commitChanges();
    },
    defer,
    afterCommit(notify: () => void): void {
      if (version === acknowledgedVersion) {
        try { notify(); } catch { /* observational */ }
      } else notifications.push(notify);
    },
    async batch<T>(operation: () => Promise<T>): Promise<T> {
      assertOpen();
      if (batchActive) throw new Error("Concurrent knowledge persistence batches are not allowed");
      if (failed) checkpoint();
      batchActive = true;
      try {
        return await operation();
      } finally {
        batchActive = false;
        if (commitRequested) commitChanges();
      }
    },
    close(): void {
      if (closed) return;
      if (batchActive) throw new Error("Cannot close a knowledge store inside a persistence batch");
      cancelTimer();
      try {
        // TriviumDB.close already performs its final checkpoint. Calling flush
        // first would rewrite the whole database twice, even without mutations.
        options.close();
      } catch (error) {
        failed = true;
        throw error; // Keep the handle and dirty state available for a retry.
      }
      durableVersion = version;
      acknowledgedVersion = version;
      failed = false;
      closed = true;
      publish();
    },
  };
}

/** Only the storage owner holds this native object. Cached bound methods keep
 * N-API's receiver intact; tracking also covers partial native failures. */
export function trackStoreMutations<T extends object>(
  database: T,
  persistence: Pick<ReturnType<typeof createStorePersistence>, "changed" | "assertOpen" | "mutationFailed">,
): T {
  const mutations = new Set([
    "insert", "batchInsert", "commitTransaction", "updatePayload", "patchPayload",
    "indexText", "indexKeyword", "link", "delete", "unlink", "unlinkLabel",
  ]);
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(database, {
    get(target, property) {
      if (methods.has(property)) return methods.get(property);
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const bound = (...args: unknown[]): unknown => {
        persistence.assertOpen();
        const mutates = mutations.has(String(property));
        if (mutates) persistence.changed();
        try { return Reflect.apply(value, target, args); } catch (error) {
          if (mutates) persistence.mutationFailed();
          throw error;
        }
      };
      methods.set(property, bound);
      return bound;
    },
  });
}
