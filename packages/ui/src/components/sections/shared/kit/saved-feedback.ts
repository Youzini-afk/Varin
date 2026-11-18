export type FlashState = 'idle' | 'saving' | 'saved' | 'error';
const flashListeners = new Set<(state: FlashState) => void>();
/** Pages whose owner does not report through the shared persistence state call this after an acknowledged save. */
export function flashSettingsSaved(state: Exclude<FlashState, 'idle'> = 'saved') { flashListeners.forEach(listener => listener(state)); }

export function subscribeToSettingsFlash(listener: (state: FlashState) => void) {
  flashListeners.add(listener);
  return () => { flashListeners.delete(listener); };
}
