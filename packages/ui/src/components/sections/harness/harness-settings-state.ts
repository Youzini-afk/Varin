import { mergeHarnessSettings, type HarnessSettings, type HarnessSettingsInput, type JsonValue, type PiSettingsSnapshot } from '@varin/protocol';

/** Objects merge, arrays replace, undefined removes a setting (restores inheritance). */
export type HarnessSettingsPatch = { [key: string]: unknown };
export interface HarnessSettingsPageProps {
  harness: HarnessSettings;
  update: (patch: HarnessSettingsPatch) => void;
}

const object = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

export function patchHarnessSettings(base: unknown, patch: HarnessSettingsPatch): Record<string, unknown> {
  const next = { ...object(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = patchHarnessSettings(next[key], value as HarnessSettingsPatch);
    } else next[key] = value;
  }
  return next;
}

interface Transport {
  read: () => Promise<PiSettingsSnapshot>;
  write: (harness: JsonValue, revision: string) => Promise<PiSettingsSnapshot>;
}
export interface HarnessSettingsState {
  harness: HarnessSettings | null;
  status: 'loading' | 'idle' | 'saving' | 'saved' | 'error';
  error: string | null;
}

/** Serializes user edits against the latest acknowledged settings revision. */
export class HarnessSettingsController {
  private confirmed: PiSettingsSnapshot | null = null;
  private pending: HarnessSettingsPatch[] = [];
  private active: Promise<void> | null = null;
  private refreshRequested = false;
  private listeners = new Set<() => void>();
  private state: HarnessSettingsState = { harness: null, status: 'loading', error: null };

  constructor(private readonly transport: Transport) {}
  getSnapshot = (): HarnessSettingsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private project(status: HarnessSettingsState['status'], error: string | null = null) {
    const raw = this.pending.reduce(patchHarnessSettings, object(this.confirmed?.global?.harness));
    let harness: HarnessSettings | null = null;
    try {
      if (this.confirmed) harness = mergeHarnessSettings(raw as HarnessSettingsInput, {});
    } catch (failure) {
      status = 'error';
      error = failure instanceof Error ? failure.message : String(failure);
    }
    this.state = { harness, status, error };
    this.listeners.forEach((listener) => listener());
  }

  update = (patch: HarnessSettingsPatch): void => {
    this.pending.push(patch);
    // Keep failures visible until retry; new input stays in the optimistic view.
    this.project(this.state.error ? 'error' : 'saving', this.state.error);
    if (!this.state.error) void this.drain();
  };

  retry = (): Promise<void> => {
    if (this.active) return this.active;
    // Refresh the revision and preserve unrelated edits made by another surface.
    this.project(this.confirmed ? 'saving' : 'loading');
    return this.drain(true);
  };

  load = (): Promise<void> => this.drain(!this.confirmed);
  /** Re-read an owner-originated change while preserving any local pending patch. */
  refresh = (): Promise<void> => this.drain(true);

  private drain(refresh = false): Promise<void> {
    if (refresh) this.refreshRequested = true;
    if (this.active) return this.active;
    const run = async () => {
      try {
        do {
          const shouldRefresh = this.refreshRequested || !this.confirmed;
          this.refreshRequested = false;
          if (shouldRefresh) this.confirmed = await this.transport.read();
          while (this.pending.length) {
            const batch = this.pending.slice();
            const revision = this.confirmed!.globalRevision;
            if (!revision) throw new Error('Settings revision is unavailable');
            const next = batch.reduce(patchHarnessSettings, object(this.confirmed!.global?.harness));
            this.project('saving');
            this.confirmed = await this.transport.write(next as JsonValue, revision);
            this.pending.splice(0, batch.length);
          }
        } while (this.refreshRequested);
        this.project(refresh ? 'idle' : 'saved');
      } catch (error) {
        this.project('error', error instanceof Error ? error.message : String(error));
      }
    };
    this.active = run().finally(() => { this.active = null; });
    return this.active;
  }
}
