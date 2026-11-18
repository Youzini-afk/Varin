export type FlashState = 'idle' | 'saving' | 'saved' | 'error';

const listeners = new Set<(state: FlashState) => void>();

export function subscribeSettingsSavedFlash(listener: (state: FlashState) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** For owners that save without publishing through the shared persistence state. */
export function flashSettingsSaved(state: Exclude<FlashState, 'idle'> = 'saved') {
  listeners.forEach(listener => listener(state));
}
