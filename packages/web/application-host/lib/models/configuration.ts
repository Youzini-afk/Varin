import { createHash } from 'node:crypto';
import { createSettingsFileStore, type VarinSettingsDocument, type SettingsFileStore } from '@varin/settings-store';
import { ConfigWatchManager } from '../configuration-watch.js';

export class ModelConfigurationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const revisionOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One file transaction owner. Reads never repair malformed user configuration. */
export class ConfigurationFile<T extends VarinSettingsDocument> {
  readonly store: SettingsFileStore;
  #valid?: { document: T; revision: string };
  readonly #listeners = new Set<(revision: string) => void>();
  readonly #watch = new ConfigWatchManager(() => { void this.#observe(); });
  #watching: Promise<string> | undefined;
  #published: string | undefined;
  constructor(path: string, readonly validate: (value: VarinSettingsDocument) => T) {
    this.store = createSettingsFileStore({ filePath: path });
  }
  async read() {
    const document = this.validate(await this.store.read());
    const result = { document, revision: revisionOf(document) };
    this.#valid = structuredClone(result);
    return result;
  }
  /** An accepted binding may consult the last valid candidate after an external bad edit. */
  async current() {
    try { return await this.read(); }
    catch (error) { if (this.#valid) return structuredClone(this.#valid); throw error; }
  }
  async update(expectedRevision: string, change: (document: T) => T) {
    const result = await this.store.transact(current => {
      const valid = this.validate(current);
      if (revisionOf(valid) !== expectedRevision) throw new ModelConfigurationError('config_conflict', 'Settings changed. Reload before saving.', 409);
      const document = this.validate(change(structuredClone(valid)));
      const revision = revisionOf(document);
      return { document, write: revision !== revisionOf(valid), result: { document, revision } };
    });
    this.#valid = structuredClone(result);
    this.#publish(result.revision);
    return result;
  }
  #publish(revision: string) {
    if (this.#published === revision) return;
    this.#published = revision;
    for (const listener of this.#listeners) {
      try { listener(revision); } catch { console.error('[Configuration] Change observer failed'); }
    }
  }
  async #observe() {
    try { this.#publish((await this.read()).revision); }
    catch { this.#publish('invalid'); }
  }
  subscribe(listener: (revision: string) => void) {
    this.#listeners.add(listener);
    if (!this.#watching) {
      const work = this.#watch.watch({ kind: 'document', path: this.store.filePath, scope: 'global' }, [this.store.filePath]).then(subscription => subscription.watchId);
      this.#watching = work;
      void work.then(() => this.#observe(), () => this.#publish('unavailable'));
    }
    return () => {
      this.#listeners.delete(listener);
      if (!this.#listeners.size) { const pending = this.#watching; this.#watching = undefined; if (pending) void pending.then(id => this.#watch.unwatch(id), () => undefined); }
    };
  }
}
