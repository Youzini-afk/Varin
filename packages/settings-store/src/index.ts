import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromisesDefault from 'node:fs/promises';
import pathDefault from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// ── Public types ─────────────────────────────────────────────────────────

export type VarinSettingsDocument = Record<string, unknown>;

export interface SettingsFileTransaction<Result> {
  document?: VarinSettingsDocument;
  result: Result;
  write?: boolean;
}

export interface SettingsFileStore {
  readonly filePath: string;
  read(): Promise<VarinSettingsDocument>;
  readSync(): VarinSettingsDocument;
  replace(settings: VarinSettingsDocument): Promise<VarinSettingsDocument>;
  transact<Result>(
    mutator: (
      current: VarinSettingsDocument,
    ) => SettingsFileTransaction<Result> | Promise<SettingsFileTransaction<Result>>,
    options?: { signal?: AbortSignal },
  ): Promise<Result>;
  update(
    mutator: (
      current: VarinSettingsDocument,
    ) => VarinSettingsDocument | void | Promise<VarinSettingsDocument | void>,
  ): Promise<VarinSettingsDocument>;
}

export interface SettingsFileStoreOptions {
  filePath: string;
  defaultValue?: VarinSettingsDocument;
  fsModule?: Pick<typeof fs, 'readFileSync'>;
  fsPromises?: Pick<
    typeof fsPromisesDefault,
    'chmod' | 'mkdir' | 'open' | 'readFile' | 'rename' | 'rm' | 'stat' | 'writeFile'
  >;
  pathModule?: Pick<typeof pathDefault, 'dirname' | 'resolve'>;
  processLike?: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>;
}

// ── Internal helpers ─────────────────────────────────────────────────────

interface LockOwner {
  pid?: unknown;
  token?: string;
}

type ReleaseLock = () => Promise<void>;

const mutationQueues = new Map<string, Promise<unknown>>();
const LOCK_RETRY_MS = 25;

const errorCode = (error: unknown): string | undefined => (
  error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
);

const assertObject = (value: unknown): VarinSettingsDocument => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Settings file is malformed (non-object payload)');
  }
  return value as VarinSettingsDocument;
};

const parseSettings = (raw: string): VarinSettingsDocument => assertObject(JSON.parse(raw));

const processIsAlive = (
  processLike: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>,
  pid: number,
): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof processLike.kill !== 'function') return false;
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
};

const enqueueMutation = <Result>(key: string, operation: () => Promise<Result>): Promise<Result> => {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.catch(() => undefined).finally(() => {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  });
  mutationQueues.set(key, settled);
  return current;
};

// ── Store factory ─────────────────────────────────────────────────────────

export const createSettingsFileStore = ({
  filePath,
  defaultValue = {},
  fsModule = fs,
  fsPromises = fsPromisesDefault,
  pathModule = pathDefault,
  processLike = process,
}: SettingsFileStoreOptions): SettingsFileStore => {
  const readDefault = (): VarinSettingsDocument => structuredClone(assertObject(defaultValue));
  const resolvedPath = pathModule.resolve(filePath);
  const lockPath = `${resolvedPath}.lock`;
  const previousPath = `${resolvedPath}.previous`;
  const directory = pathModule.dirname(resolvedPath);

  const read = async (): Promise<VarinSettingsDocument> => {
    try {
      return parseSettings(await fsPromises.readFile(resolvedPath, 'utf8'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        try {
          return parseSettings(await fsPromises.readFile(previousPath, 'utf8'));
        } catch (previousError) {
          if (errorCode(previousError) === 'ENOENT') return readDefault();
          throw previousError;
        }
      }
      throw error;
    }
  };

  const readSync = (): VarinSettingsDocument => {
    try {
      return parseSettings(fsModule.readFileSync(resolvedPath, 'utf8'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        try {
          return parseSettings(fsModule.readFileSync(previousPath, 'utf8'));
        } catch (previousError) {
          if (errorCode(previousError) === 'ENOENT') return readDefault();
          throw previousError;
        }
      }
      throw error;
    }
  };

  const acquireLock = async (signal?: AbortSignal): Promise<ReleaseLock> => {
    signal?.throwIfAborted();
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    for (;;) {
      signal?.throwIfAborted();
      let handle: import('node:fs/promises').FileHandle | undefined;
      try {
        handle = await fsPromises.open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      if (handle) {
        const token = randomUUID();
        try {
          await handle.writeFile(JSON.stringify({ pid: processLike.pid, token }), 'utf8');
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await fsPromises.rm(lockPath, { force: true }).catch(() => undefined);
          throw error;
        }
        const acquiredHandle = handle;
        return async () => {
          await acquiredHandle.close();
          try {
            const owner = JSON.parse(await fsPromises.readFile(lockPath, 'utf8')) as LockOwner;
            if (owner?.token === token) await fsPromises.rm(lockPath, { force: true });
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
        };
      }

      let abandoned = false;
      try {
        const owner = JSON.parse(await fsPromises.readFile(lockPath, 'utf8')) as LockOwner;
        abandoned = !processIsAlive(processLike, Number(owner?.pid));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        try {
          abandoned = Date.now() - (await fsPromises.stat(lockPath)).mtimeMs > 2_000;
        } catch (statError) {
          if (errorCode(statError) === 'ENOENT') continue;
          throw statError;
        }
      }

      if (abandoned) {
        const moved = `${lockPath}.abandoned.${processLike.pid}.${randomUUID()}`;
        try {
          await fsPromises.rename(lockPath, moved);
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          throw error;
        }
        await fsPromises.rm(moved, { force: true });
        continue;
      }
      await delay(LOCK_RETRY_MS, undefined, { signal });
    }
  };

  const replaceFile = async (temporaryPath: string): Promise<void> => {
    try {
      await fsPromises.rename(temporaryPath, resolvedPath);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (processLike.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EEXIST')) {
        throw error;
      }
    }

    await fsPromises.rm(previousPath, { force: true });
    let movedCurrent = false;
    try {
      await fsPromises.rename(resolvedPath, previousPath);
      movedCurrent = true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    try {
      await fsPromises.rename(temporaryPath, resolvedPath);
    } catch (error) {
      if (movedCurrent) await fsPromises.rename(previousPath, resolvedPath).catch(() => undefined);
      throw error;
    }
    if (movedCurrent) await fsPromises.rm(previousPath, { force: true });
  };

  const writeUnlocked = async (settings: VarinSettingsDocument): Promise<void> => {
    assertObject(settings);
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    if (processLike.platform !== 'win32') await fsPromises.chmod(directory, 0o700);
    const temporaryPath = `${resolvedPath}.tmp-${processLike.pid}-${randomUUID()}`;
    try {
      await fsPromises.writeFile(temporaryPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (processLike.platform !== 'win32') await fsPromises.chmod(temporaryPath, 0o600);
      await replaceFile(temporaryPath);
      if (processLike.platform !== 'win32') await fsPromises.chmod(resolvedPath, 0o600);
    } finally {
      await fsPromises.rm(temporaryPath, { force: true });
    }
  };

  const withMutationLock = <Result>(operation: () => Promise<Result>, signal?: AbortSignal): Promise<Result> => enqueueMutation(resolvedPath, async () => {
    const release = await acquireLock(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await release();
    }
  });

  const replace = (settings: VarinSettingsDocument): Promise<VarinSettingsDocument> => withMutationLock(async () => {
    await writeUnlocked(settings);
    return settings;
  });

  const transact = <Result>(
    mutator: (current: VarinSettingsDocument) => SettingsFileTransaction<Result> | Promise<SettingsFileTransaction<Result>>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result> => withMutationLock(async () => {
    const current = await read();
    // Once the mutator starts, finish its atomic commit before releasing the
    // lock. Cancellation while queued or acquiring a lock never starts it.
    options.signal?.throwIfAborted();
    const transaction = await mutator(structuredClone(current));
    if (transaction === null || typeof transaction !== 'object' || Array.isArray(transaction)) {
      throw new Error('Settings transaction must return an object');
    }
    const next = assertObject(transaction.document ?? current);
    if (transaction.write !== false) await writeUnlocked(next);
    return transaction.result;
  }, options.signal);

  const update = (
    mutator: (current: VarinSettingsDocument) => VarinSettingsDocument | void | Promise<VarinSettingsDocument | void>,
  ): Promise<VarinSettingsDocument> => transact(async (current) => {
    const next = assertObject((await mutator(current)) ?? current);
    return { document: next, result: next };
  });

  return { filePath: resolvedPath, read, readSync, replace, transact, update };
};
