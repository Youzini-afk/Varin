import { registerRuntimeEndpointSwitchBlocker } from '@varin/application-client';
/** Settings drafts stay with their real owner; this registry only coordinates leaving a page. */
export interface SettingsDraft {
  dirty: boolean;
  saving: boolean;
  saveDisabled: boolean;
  onSave?: () => unknown | Promise<unknown>;
  onCancel: () => void;
}
const drafts = new Map<string, () => SettingsDraft>();
const listeners = new Set<() => void>();
let serial = 0;
let pending: { id: number; proceed: () => void; cancel?: () => void; ids: string[] } | null = null;
let finishing = false;
const notify = () => listeners.forEach((listener) => listener());
export const subscribeSettingsNavigation = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getPendingSettingsNavigation = () => pending;
export function registerSettingsDraft(id: string, read: () => SettingsDraft) {
  drafts.set(id, read);
  return () => { drafts.delete(id); };
}
export function requestSettingsNavigation(proceed: () => void, cancel?: () => void): void {
  const ids = [...drafts].filter(([, read]) => read().dirty || read().saving).map(([id]) => id);
  pending?.cancel?.();
  pending = null;
  if (!ids.length) { notify(); proceed(); return; }
  pending = { id: ++serial, proceed, cancel, ids };
  notify();
}
export function stayInSettings(): void { pending?.cancel?.(); pending = null; notify(); }
export function notifySettingsDraftChanged(): void { if (pending) { pending = { ...pending }; notify(); } }
export function pendingSettingsDrafts(): SettingsDraft[] { return pending?.ids.flatMap(id => { const read = drafts.get(id); return read ? [read()] : []; }) ?? []; }
export async function finishSettingsNavigation(save: boolean): Promise<boolean> {
  const request = pending;
  if (!request) return true;
  if (finishing) return false;
  const entries = request.ids.flatMap(id => { const read = drafts.get(id); return read ? [{ id, state: read() }] : []; });
  if (entries.some(({ state }) => state.saving || (save && state.dirty && (state.saveDisabled || !state.onSave)))) return false;
  finishing = true;
  try {
    for (const { id } of entries) {
      if (pending?.id !== request.id) return false;
      const read = drafts.get(id);
      if (!read) continue;
      const state = read();
      if (state.saving || (save && state.dirty && (state.saveDisabled || !state.onSave))) return false;
      if (!save) { state.onCancel(); continue; }
      if (!state.dirty) continue;
      const result = await state.onSave?.();
      if (result === false || pending?.id !== request.id) return false;
      // Owner state is rendered after its acknowledged save, before navigation.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      // Some owners close their editor after an acknowledged save. Its detached
      // ref retains the last dirty render, so only the live registration counts.
      const current = drafts.get(id)?.();
      if (current?.dirty || current?.saving) return false;
    }
    if (pending?.id !== request.id) return false;
    pending = null; notify(); request.proceed(); return true;
  } finally { finishing = false; }
}

// Register before page-owned connection teardown: unsaved credentials/configuration stay with their Host.
registerRuntimeEndpointSwitchBlocker(async () => {
  const allowed = await new Promise<boolean>(resolve => requestSettingsNavigation(() => resolve(true), () => resolve(false)));
  if (!allowed) throw new Error('Settings changes were not saved or discarded');
}, { phase: 'guard' });
