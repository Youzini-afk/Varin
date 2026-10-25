/**
 * Light haptics, only at commit points (docs/design/motion-and-interaction.md §3.14): switching the
 * session, sending, a run finishing. The native app taps through `@capacitor/haptics`; a touch-first
 * browser with `navigator.vibrate` (Android) gives a short pulse; everything else stays silent. The
 * operating system's own haptics setting still applies on top.
 */

type CapacitorWindow = Window & { Capacitor?: { isNativePlatform?: () => boolean } };
type HapticsModule = typeof import('@capacitor/haptics');

let native: Promise<HapticsModule | null> | null = null;

const isNativeApp = (): boolean => (
  typeof window !== 'undefined' && (window as CapacitorWindow).Capacitor?.isNativePlatform?.() === true
);

const touchFirst = (): boolean => (
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches
);

export type HapticStrength = 'light' | 'medium';

/** A short tap. Never throws and never waits. */
export function tapHaptic(strength: HapticStrength = 'light'): void {
  if (isNativeApp()) {
    native ??= import('@capacitor/haptics').catch(() => null);
    void native.then((module) => module?.Haptics.impact({
      style: strength === 'medium' ? module.ImpactStyle.Medium : module.ImpactStyle.Light,
    })).catch(() => undefined);
    return;
  }
  if (!touchFirst() || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(strength === 'medium' ? 14 : 8);
  } catch {
    // A browser may refuse without a recent user gesture; silence is the right fallback.
  }
}
