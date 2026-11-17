/** Persisted by the existing Host settings owner, never by the runtime itself. */
export interface ExternalAccessRecord<Config> {
  revision: number;
  enabled: boolean;
  config: Config | null;
}

export type ExternalAccessFailureCode = 'invalid_config' | 'authentication_failed' | 'port_in_use'
  | 'network_error' | 'process_exited' | 'start_failed' | 'stop_failed' | 'persistence_failed'
  | 'revision_conflict' | 'not_configured' | 'not_enabled' | 'shutting_down' | 'provider_in_use';

export interface ExternalAccessFailure {
  code: ExternalAccessFailureCode;
  message: string;
  retryable: boolean;
}

export interface ExternalAccessRuntimeStatus {
  revision: number;
  enabled: boolean;
  state: 'disabled' | 'connecting' | 'enabled' | 'connected' | 'reconnecting' | 'stopping' | 'failed';
  activeRevision: number | null;
  error: ExternalAccessFailure | null;
  retryAttempt: number;
  retryAt: number | null;
}

export interface ExternalAccessResource {
  /** A managed protocol can prove publication; an external service only has a local enabled listener. */
  state: 'enabled' | 'connected';
  /** Immediately deny new ingress and disconnect existing streams before async teardown. */
  fence(): void;
  /** Resolve only after listeners/processes are actually released. Safe to retry on failure. */
  stop(): Promise<void>;
}

export interface ExternalAccessOpenContext {
  signal: AbortSignal;
  /** May be called during open; stale calls are ignored. Never pass log text to clients. */
  onDisconnected(error: unknown): void;
}

export interface ExternalAccessRuntimeOptions<Config> {
  read(): Promise<ExternalAccessRecord<Config>>;
  /** Atomic in the settings owner. False means no write took place. */
  compareAndSwap(expectedRevision: number, next: ExternalAccessRecord<Config>): Promise<boolean>;
  normalizeConfig(input: unknown): Config;
  /** Abort must fence provisional ingress and settle after cleaning up partial resources. */
  open(config: Config, context: ExternalAccessOpenContext): Promise<ExternalAccessResource>;
  /** Return only a known code, never raw provider stderr, configuration, or exception text. */
  classifyError?(error: unknown): ExternalAccessFailureCode;
  onStatus?(status: ExternalAccessRuntimeStatus): void;
  /** Backoff steps; keep retrying at the final delay while enabled. [] disables recovery. */
  retryDelaysMs?: readonly number[];
}

const FAILURE_MESSAGES: Record<ExternalAccessFailureCode, string> = {
  invalid_config: 'External access configuration is invalid.',
  provider_in_use: 'Disable the active Cloudflare/ngrok tunnel before using this ingress.',
  authentication_failed: 'The forwarding server rejected the credentials.',
  port_in_use: 'The configured backend address or port is unavailable.',
  network_error: 'The external access connection was interrupted.',
  process_exited: 'The forwarding process stopped unexpectedly.',
  start_failed: 'External access could not be started.',
  stop_failed: 'External access resources have not finished stopping.',
  persistence_failed: 'External access settings could not be saved or read.',
  revision_conflict: 'External access settings changed. Reload before applying changes.',
  not_configured: 'Save an external access configuration before enabling it.',
  not_enabled: 'Enable external access before retrying it.',
  shutting_down: 'The Host is shutting down.',
};

export class ExternalAccessRuntimeError extends Error {
  constructor(readonly code: ExternalAccessFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = 'ExternalAccessRuntimeError';
  }
}

type Target<Config> = { config: Config; revision: number };
type Active<Config> = Target<Config> & { resource: ExternalAccessResource; controller: AbortController };

/** One settings writer and one resource owner. Observing state never starts/stops resources. */
export function createExternalAccessRuntime<Config>(options: ExternalAccessRuntimeOptions<Config>) {
  let saved: ExternalAccessRecord<Config> = { revision: 0, enabled: false, config: null };
  let status: ExternalAccessRuntimeStatus = {
    revision: 0, enabled: false, state: 'disabled', activeRevision: null,
    error: null, retryAttempt: 0, retryAt: null,
  };
  let started = false;
  let shuttingDown = false;
  let generation = 0;
  let active: Active<Config> | null = null;
  let opening: AbortController | null = null;
  let writes = Promise.resolve();
  let work = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const retryDelays = options.retryDelaysMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];

  const getStatus = (): ExternalAccessRuntimeStatus => structuredClone(status);
  const publish = (patch: Partial<ExternalAccessRuntimeStatus>) => {
    const next = { ...status, ...patch, revision: saved.revision, enabled: saved.enabled };
    if (next.revision === status.revision && next.enabled === status.enabled && next.state === status.state
      && next.activeRevision === status.activeRevision && next.error?.code === status.error?.code
      && next.retryAttempt === status.retryAttempt && next.retryAt === status.retryAt) return;
    status = next;
    // Observers must not turn a committed intent or resource transition into a failed write.
    try { options.onStatus?.(getStatus()); } catch { /* Observer failure is not lifecycle failure. */ }
  };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation);
    writes = result.then(() => undefined, () => undefined);
    return result;
  };
  const fail = (code: ExternalAccessFailureCode): ExternalAccessFailure => ({
    code, message: FAILURE_MESSAGES[code], retryable: code === 'network_error' || code === 'process_exited',
  });
  const classify = (error: unknown): ExternalAccessFailure => {
    let code: ExternalAccessFailureCode = 'start_failed';
    if (error instanceof ExternalAccessRuntimeError) code = error.code;
    else {
      try {
        const classified = options.classifyError?.(error);
        if (classified && Object.hasOwn(FAILURE_MESSAGES, classified)) code = classified;
      } catch { /* Never expose a classifier exception or provider log text. */ }
    }
    return fail(code);
  };
  const cancelRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const fence = () => {
    opening?.abort();
    // Keep ownership even if fencing fails; stop() still gets a chance to release it.
    try { active?.resource.fence(); } catch { publish({ error: fail('stop_failed') }); }
  };
  const stopActive = async () => {
    const previous = active;
    if (!previous) return;
    try { previous.resource.fence(); } catch { /* Still attempt actual resource release. */ }
    await previous.resource.stop();
    if (active === previous) active = null;
  };
  const readRecord = async () => {
    let record: ExternalAccessRecord<Config>;
    try { record = structuredClone(await options.read()); } catch {
      throw new ExternalAccessRuntimeError('persistence_failed');
    }
    if (!record || !Number.isSafeInteger(record.revision) || record.revision < 0
      || typeof record.enabled !== 'boolean' || !Object.hasOwn(record, 'config')) {
      throw new ExternalAccessRuntimeError('persistence_failed');
    }
    saved = record;
    publish({});
    return structuredClone(record);
  };
  const assertOpen = () => {
    if (shuttingDown) throw new ExternalAccessRuntimeError('shutting_down');
  };
  const currentRecord = async (expectedRevision: number) => {
    assertOpen();
    const record = await readRecord();
    assertOpen();
    if (record.revision !== expectedRevision) throw new ExternalAccessRuntimeError('revision_conflict');
    return record;
  };
  const persist = async (record: ExternalAccessRecord<Config>, next: Omit<ExternalAccessRecord<Config>, 'revision'>) => {
    if (record.revision === Number.MAX_SAFE_INTEGER) throw new ExternalAccessRuntimeError('persistence_failed');
    const candidate = { ...next, revision: record.revision + 1 };
    let committed: boolean;
    try { committed = await options.compareAndSwap(record.revision, structuredClone(candidate)); } catch {
      throw new ExternalAccessRuntimeError('persistence_failed');
    }
    if (!committed) throw new ExternalAccessRuntimeError('revision_conflict');
    saved = candidate;
    publish({});
  };
  const normalize = (input: unknown): Config => {
    try { return structuredClone(options.normalizeConfig(structuredClone(input))); } catch {
      throw new ExternalAccessRuntimeError('invalid_config');
    }
  };
  const targetFor = (record: ExternalAccessRecord<Config>): Target<Config> => {
    if (record.config === null) throw new ExternalAccessRuntimeError('not_configured');
    return { config: normalize(record.config), revision: record.revision };
  };

  const scheduleRetry = (target: Target<Config>, failure: ExternalAccessFailure, epoch: number) => {
    if (epoch !== generation || shuttingDown) return;
    const delay = retryDelays[Math.min(status.retryAttempt, retryDelays.length - 1)];
    if (!failure.retryable || delay === undefined || target.revision !== saved.revision) {
      publish({ state: 'failed', error: failure, retryAt: null });
      return;
    }
    publish({ state: 'reconnecting', error: failure, retryAttempt: status.retryAttempt + 1, retryAt: Date.now() + delay });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (epoch !== generation || shuttingDown) return;
      transition(target, false, true);
    }, delay);
    retryTimer.unref?.();
  };

  const disconnected = (target: Target<Config>, error: unknown, epoch: number) => {
    if (epoch !== generation || shuttingDown) return;
    const failure = classify(error);
    const nextEpoch = ++generation;
    cancelRetry();
    fence();
    publish({ state: 'reconnecting', error: failure, retryAt: null });
    work = work.then(async () => {
      try { await stopActive(); } catch {
        if (nextEpoch === generation) publish({ state: 'failed', error: fail('stop_failed') });
        return;
      }
      if (nextEpoch !== generation || shuttingDown) return;
      publish({ activeRevision: null });
      scheduleRetry(target, failure, nextEpoch);
    });
  };

  const openTarget = async (target: Target<Config>, epoch: number): Promise<ExternalAccessResource['state'] | null> => {
    const controller = new AbortController();
    opening = controller;
    let earlyDisconnect: { error: unknown } | null = null;
    try {
      const resource = await options.open(structuredClone(target.config), {
        signal: controller.signal,
        onDisconnected: (error) => {
          if (epoch !== generation || shuttingDown || controller.signal.aborted) return;
          if (active?.controller === controller) disconnected(target, error, epoch);
          else if (opening === controller) { earlyDisconnect = { error }; controller.abort(); }
        },
      });
      active = { ...target, controller, resource };
      if (epoch !== generation || shuttingDown || controller.signal.aborted) {
        await stopActive();
        if (earlyDisconnect) throw (earlyDisconnect as { error: unknown }).error;
        return null;
      }
      return resource.state;
    } catch (error) {
      controller.abort();
      if (earlyDisconnect) throw (earlyDisconnect as { error: unknown }).error;
      throw error;
    } finally {
      if (opening === controller) opening = null;
    }
  };

  // Async opening/teardown is serialized separately from settings writes. A newer disable
  // can therefore commit and synchronously fence while an older open is still settling.
  const transition = (target: Target<Config> | null, allowRollback: boolean, automatic = false): Promise<ExternalAccessRuntimeStatus> => {
    const epoch = ++generation;
    cancelRetry();
    const previous = active ? { config: structuredClone(active.config), revision: active.revision } : null;
    fence();
    publish({
      state: target ? (automatic ? 'reconnecting' : 'connecting') : 'stopping',
      error: null, retryAt: null,
      ...(!automatic ? { retryAttempt: 0 } : {}),
    });
    const completion = work.then(async () => {
      if (epoch !== generation) return;
      try { await stopActive(); } catch {
        if (epoch === generation) publish({ state: 'failed', error: fail('stop_failed') });
        return;
      }
      if (epoch !== generation) return;
      publish({ activeRevision: null });
      if (!target || shuttingDown) {
        publish({ state: 'disabled' });
        return;
      }
      try {
        const nextState = await openTarget(target, epoch);
        if (!nextState || epoch !== generation || shuttingDown) return;
        publish({ state: nextState,
          activeRevision: target.revision,
          error: null, retryAttempt: 0, retryAt: null });
      } catch (error) {
        if (epoch !== generation || shuttingDown) return;
        const failure = classify(error);
        // A failed stop retains resource ownership. Never bind another listener over it.
        if (active) {
          publish({ state: 'failed', error: fail('stop_failed') });
          return;
        }
        if (allowRollback && previous) {
          try {
            const restoredState = await openTarget(previous, epoch);
            if (!restoredState || epoch !== generation || shuttingDown) return;
            // The old listener remains useful, but the error describes the rejected draft.
            publish({ state: restoredState, activeRevision: previous.revision,
              error: failure, retryAt: null });
            return;
          } catch {
            if (epoch !== generation || shuttingDown) return;
            if (active) { publish({ state: 'failed', error: fail('stop_failed') }); return; }
          }
        }
        scheduleRetry(target, failure, epoch);
      }
    });
    work = completion;
    return completion.then(getStatus);
  };

  const beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ++generation;
    cancelRetry();
    fence();
    publish({ state: 'stopping', retryAt: null });
  };

  return {
    getStatus,
    read: () => serial(readRecord),
    start: async () => {
      const result = await serial(async () => {
        assertOpen();
        if (started) return { completion: work.then(getStatus) };
        const record = await readRecord();
        assertOpen();
        started = true;
        if (!record.enabled) return { completion: Promise.resolve(getStatus()) };
        try { return { completion: transition(targetFor(record), false) }; } catch (error) {
          publish({ state: 'failed', error: classify(error) });
          return { completion: Promise.resolve(getStatus()) };
        }
      });
      return result.completion;
    },
    save: (input: unknown, expectedRevision: number) => serial(async () => {
      const record = await currentRecord(expectedRevision);
      const config = normalize(input);
      await persist(record, { config, enabled: record.enabled });
      cancelRetry();
      publish({ retryAt: null, ...(status.state === 'reconnecting' ? { state: 'failed' as const } : {}) });
      return getStatus();
    }),
    enable: async (expectedRevision: number) => {
      const result = await serial(async () => {
        const record = await currentRecord(expectedRevision);
        const target = targetFor(record);
        await persist(record, { config: record.config, enabled: true });
        return { completion: transition({ ...target, revision: saved.revision }, true) };
      });
      return result.completion;
    },
    disable: async (expectedRevision: number) => {
      const result = await serial(async () => {
        const record = await currentRecord(expectedRevision);
        await persist(record, { config: record.config, enabled: false });
        return { completion: transition(null, false) };
      });
      return result.completion;
    },
    remove: async (expectedRevision: number) => {
      const result = await serial(async () => {
        const record = await currentRecord(expectedRevision);
        if (!record.config) throw new ExternalAccessRuntimeError('not_configured');
        await persist(record, { config: null, enabled: false });
        return { completion: transition(null, false) };
      });
      return result.completion;
    },
    retry: async (expectedRevision: number) => {
      const result = await serial(async () => {
        const record = await currentRecord(expectedRevision);
        if (!record.enabled) throw new ExternalAccessRuntimeError('not_enabled');
        return { completion: transition(targetFor(record), true) };
      });
      return result.completion;
    },
    beginShutdown,
    shutdown: async () => {
      beginShutdown();
      const result = await serial(async () => ({ completion: transition(null, false) }));
      return result.completion;
    },
  };
}
