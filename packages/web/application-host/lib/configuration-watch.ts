import { randomUUID } from "node:crypto";
import { realpath as realpathCallback, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { HostError } from "./configuration-errors.js";
type ConfigWatchChangeReason = 'change' | 'rename' | 'error';
export interface ConfigWatchTarget { kind: 'document'; path: string; scope: 'global' | 'project' }
interface ConfigWatchSubscription { target: ConfigWatchTarget; watchId: string }

const COALESCE_DELAY_MS = 20;
const WIN32 = process.platform === "win32";
const realpathNative = promisify(realpathCallback.native);

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

function reasonPriority(reason: ConfigWatchChangeReason): number {
  return reason === "error" ? 3 : reason === "rename" ? 2 : 1;
}

function sameWindowsText(left: string, right: string): boolean {
  return left.localeCompare(right, "en", { sensitivity: "accent" }) === 0;
}

function sameFileName(left: string, right: string): boolean {
  return WIN32 ? sameWindowsText(left, right) : left === right;
}

function sameDirectory(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return WIN32 ? sameWindowsText(resolvedLeft, resolvedRight) : resolvedLeft === resolvedRight;
}

function firstPathSegment(value: string): string | undefined {
  const segment = value.split(/[\\/]/, 1)[0];
  return segment === undefined || segment.length === 0 ? undefined : segment;
}

function stripWindowsNamespacePrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path);
  if (!WIN32) return resolved;
  try {
    return stripWindowsNamespacePrefix(await realpathNative(resolved));
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const parent = dirname(resolved);
    if (parent === resolved) return resolved;
    return join(await canonicalPath(parent), basename(resolved));
  }
}

async function deepestExistingDirectory(filePath: string): Promise<string> {
  let candidate = dirname(resolve(filePath));
  while (true) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new HostError(
        "config_watch_failed",
        `No existing directory is available for configuration watch: ${filePath}`,
      );
    }
    candidate = parent;
  }
}

class ConfigPathWatcher {
  readonly #filePath: string;
  readonly #notify: (reason: ConfigWatchChangeReason) => void;
  #directory: string | undefined;
  #disposed = false;
  #generation = 0;
  #queue: Promise<void> = Promise.resolve();
  #watcher: FSWatcher | undefined;

  constructor(filePath: string, notify: (reason: ConfigWatchChangeReason) => void) {
    this.#filePath = resolve(filePath);
    this.#notify = notify;
  }

  async start(): Promise<void> {
    await this.#enqueue(() => this.#bind(this.#generation));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#closeWatcher();
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  #closeWatcher(): void {
    const watcher = this.#watcher;
    this.#watcher = undefined;
    this.#directory = undefined;
    watcher?.close();
  }

  #requestRebind(generation: number): void {
    if (this.#disposed || generation !== this.#generation) return;
    void this.#enqueue(() => new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.#rebind(generation).then(resolve, resolve);
      });
    }));
  }

  async #rebind(expectedGeneration: number): Promise<void> {
    if (this.#disposed || expectedGeneration !== this.#generation) return;
    let directory: string;
    try {
      directory = await canonicalPath(await deepestExistingDirectory(this.#filePath));
    } catch {
      if (!this.#disposed && expectedGeneration === this.#generation) this.#notify("error");
      return;
    }
    if (this.#disposed || expectedGeneration !== this.#generation) return;
    if (
      this.#watcher !== undefined
      && this.#directory !== undefined
      && sameDirectory(this.#directory, directory)
    ) {
      return;
    }
    const generation = ++this.#generation;
    this.#closeWatcher();
    try {
      await this.#bind(generation);
    } catch {
      if (!this.#disposed && generation === this.#generation) this.#notify("error");
    }
  }

  async #bind(generation: number): Promise<void> {
    const directory = await canonicalPath(await deepestExistingDirectory(this.#filePath));
    const filePath = await canonicalPath(this.#filePath);
    if (this.#disposed || generation !== this.#generation) return;
    const relativePath = relative(directory, filePath);
    const watchedSegment = firstPathSegment(relativePath);
    if (!watchedSegment) {
      throw new HostError("config_watch_failed", "Configuration watch target must be a file");
    }
    let watcher: FSWatcher;
    try {
      // Windows libuv aborts in fs-event.c when fs.watch() is given an 8.3
      // short directory (GitHub Actions %TEMP%) because events arrive with the
      // long path. Canonicalize before watching; never close from the callback.
      watcher = watch(directory, (eventType, filename) => {
        if (this.#disposed || generation !== this.#generation) return;
        const changedName = filename === null || filename === undefined
          ? undefined
          : firstPathSegment(String(filename));
        if (changedName !== undefined && !sameFileName(changedName, watchedSegment)) return;
        const reason = eventType === "rename" ? "rename" : "change";
        this.#notify(reason);
        if (reason === "rename") this.#requestRebind(generation);
      });
      watcher.unref();
    } catch (error) {
      throw new HostError(
        "config_watch_failed",
        `Failed to watch configuration path: ${this.#filePath}`,
        { cause: error },
      );
    }
    watcher.on("error", () => {
      if (this.#disposed || generation !== this.#generation) return;
      this.#notify("error");
      this.#requestRebind(generation);
    });
    if (this.#disposed || generation !== this.#generation) {
      watcher.close();
      return;
    }
    this.#closeWatcher();
    this.#watcher = watcher;
    this.#directory = directory;
  }
}

class ConfigWatchEntry {
  readonly #emit: (reason: ConfigWatchChangeReason) => void;
  readonly #paths: readonly string[];
  #pendingReason: ConfigWatchChangeReason | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #watchers: ConfigPathWatcher[] = [];

  constructor(paths: readonly string[], emit: (reason: ConfigWatchChangeReason) => void) {
    this.#emit = emit;
    this.#paths = paths;
  }

  async start(): Promise<void> {
    const watchers = this.#paths.map((path) => new ConfigPathWatcher(path, (reason) => {
      this.#schedule(reason);
    }));
    this.#watchers = watchers;
    try {
      await Promise.all(watchers.map((watcher) => watcher.start()));
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pendingReason = undefined;
    for (const watcher of this.#watchers) watcher.dispose();
    this.#watchers = [];
  }

  #schedule(reason: ConfigWatchChangeReason): void {
    if (
      this.#pendingReason === undefined
      || reasonPriority(reason) > reasonPriority(this.#pendingReason)
    ) {
      this.#pendingReason = reason;
    }
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const pending = this.#pendingReason;
      this.#pendingReason = undefined;
      if (pending !== undefined) this.#emit(pending);
    }, COALESCE_DELAY_MS);
    this.#timer.unref?.();
  }
}

export class ConfigWatchManager {
  readonly #emit: (
    subscription: ConfigWatchSubscription,
    reason: ConfigWatchChangeReason,
  ) => void;
  readonly #entries = new Map<string, ConfigWatchEntry>();

  constructor(
    emit: (
      subscription: ConfigWatchSubscription,
      reason: ConfigWatchChangeReason,
    ) => void,
  ) {
    this.#emit = emit;
  }

  async watch(
    target: ConfigWatchTarget,
    paths: readonly string[],
  ): Promise<ConfigWatchSubscription> {
    const watchId = randomUUID();
    const subscription = { target, watchId } satisfies ConfigWatchSubscription;
    const entry = new ConfigWatchEntry(paths, (reason) => this.#emit(subscription, reason));
    await entry.start();
    this.#entries.set(watchId, entry);
    return subscription;
  }

  unwatch(watchId: string): boolean {
    const entry = this.#entries.get(watchId);
    if (!entry) return false;
    this.#entries.delete(watchId);
    entry.dispose();
    return true;
  }

  close(): void {
    for (const entry of this.#entries.values()) entry.dispose();
    this.#entries.clear();
  }
}
