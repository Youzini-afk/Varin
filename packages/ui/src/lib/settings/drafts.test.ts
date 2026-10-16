import { afterEach, expect, test, vi } from 'vitest';
vi.mock('@varin/application-client', () => ({ registerRuntimeEndpointSwitchBlocker: vi.fn() }));
import { finishSettingsNavigation, getPendingSettingsNavigation, registerSettingsDraft, requestSettingsNavigation, stayInSettings, type SettingsDraft } from './drafts';
const release: Array<() => void> = [];
afterEach(() => { stayInSettings(); release.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); });
function draft(value: Partial<SettingsDraft> = {}) {
  const state: SettingsDraft = { dirty: true, saving: false, saveDisabled: false, onCancel: vi.fn(), ...value };
  release.push(registerSettingsDraft(String(release.length), () => state)); return state;
}
test('clean navigation proceeds without asking, while cancelling leaves the draft intact', () => {
  const proceed = vi.fn(); requestSettingsNavigation(proceed); expect(proceed).toHaveBeenCalledOnce();
  const state = draft(); requestSettingsNavigation(proceed); expect(getPendingSettingsNavigation()).not.toBeNull();
  stayInSettings(); expect(state.onCancel).not.toHaveBeenCalled(); expect(proceed).toHaveBeenCalledOnce();
});
test('discard changes only the registered save units before leaving', async () => {
  const state = draft(); const proceed = vi.fn(); requestSettingsNavigation(proceed);
  expect(await finishSettingsNavigation(false)).toBe(true); expect(state.onCancel).toHaveBeenCalledOnce(); expect(proceed).toHaveBeenCalledOnce();
});
test('a failed save or still-dirty acknowledged callback never navigates', async () => {
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 1; });
  const state = draft({ onSave: async () => false }); const proceed = vi.fn(); requestSettingsNavigation(proceed);
  expect(await finishSettingsNavigation(true)).toBe(false); expect(proceed).not.toHaveBeenCalled();
  state.onSave = async () => true; expect(await finishSettingsNavigation(true)).toBe(false); expect(proceed).not.toHaveBeenCalled();
  state.onSave = async () => { state.dirty = false; return true; };
  expect(await finishSettingsNavigation(true)).toBe(true); expect(proceed).toHaveBeenCalledOnce();
});
test('an in-flight write cannot be discarded or replayed by a second click', async () => {
  const state = draft({ saving: true, onSave: vi.fn() }); const proceed = vi.fn(); requestSettingsNavigation(proceed);
  expect(await finishSettingsNavigation(false)).toBe(false); expect(await finishSettingsNavigation(true)).toBe(false);
  expect(state.onCancel).not.toHaveBeenCalled(); expect(state.onSave).not.toHaveBeenCalled(); expect(proceed).not.toHaveBeenCalled();
});
test('serializes confirmation clicks before the owner publishes its saving state', async () => {
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 1; });
  let complete!: () => void;
  const state = draft({ onSave: vi.fn(() => new Promise<void>(resolve => { complete = resolve; })) });
  const proceed = vi.fn(); requestSettingsNavigation(proceed);
  const first = finishSettingsNavigation(true);
  expect(await finishSettingsNavigation(true)).toBe(false);
  expect(await finishSettingsNavigation(false)).toBe(false);
  expect(state.onSave).toHaveBeenCalledOnce(); expect(state.onCancel).not.toHaveBeenCalled();
  state.dirty = false; complete();
  expect(await first).toBe(true); expect(proceed).toHaveBeenCalledOnce();
});
test('a newer navigation cancels the old request and never saves its remaining units', async () => {
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 1; });
  let complete!: () => void;
  const first = draft({ onSave: () => new Promise<void>(resolve => { complete = resolve; }) });
  const second = draft({ onSave: vi.fn() });
  const oldProceed = vi.fn(), oldCancel = vi.fn(), newProceed = vi.fn();
  requestSettingsNavigation(oldProceed, oldCancel);
  const saving = finishSettingsNavigation(true);
  requestSettingsNavigation(newProceed);
  first.dirty = false; complete();
  expect(await saving).toBe(false); expect(oldCancel).toHaveBeenCalledOnce();
  expect(second.onSave).not.toHaveBeenCalled(); expect(oldProceed).not.toHaveBeenCalled();
  expect(await finishSettingsNavigation(false)).toBe(true); expect(newProceed).toHaveBeenCalledOnce();
});
test('a clean newer navigation settles the previous Host guard rather than stranding it', () => {
  const state = draft(), oldProceed = vi.fn(), oldCancel = vi.fn(), newProceed = vi.fn();
  requestSettingsNavigation(oldProceed, oldCancel);
  state.dirty = false;
  requestSettingsNavigation(newProceed);
  expect(oldCancel).toHaveBeenCalledOnce(); expect(oldProceed).not.toHaveBeenCalled();
  expect(newProceed).toHaveBeenCalledOnce(); expect(getPendingSettingsNavigation()).toBeNull();
});
test('an acknowledged save may retire its editor without leaving a stale dirty ref blocking navigation', async () => {
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 1; });
  const unregister = registerSettingsDraft('editor', () => ({ dirty: true, saving: false, saveDisabled: false, onCancel: vi.fn(),
    onSave: async () => { unregister(); return true; },
  }));
  release.push(unregister);
  const proceed = vi.fn(); requestSettingsNavigation(proceed);
  expect(await finishSettingsNavigation(true)).toBe(true); expect(proceed).toHaveBeenCalledOnce();
});
