/**
 * Authoritative desktop boot outcome types and UI-facing resolver.
 *
 * The Rust backend computes a `DesktopBootOutcome` at startup and injects
 * it as `window.__VARIN_DESKTOP_BOOT_OUTCOME__`. This module provides
 * pure functions to read that outcome and derive the minimal UI state
 * needed for the loading/chooser/recovery/main decision.
 */

// ── Boot outcome (must match Rust injection) ──

/**
 * Structured boot outcome type.
 *
 * Instead of 8 magic string kinds, we use a structured type that clearly
 * separates the target (local/remote/null) from the status (ok/not-configured/error).
 *
 * This makes it easier to add new states without updating multiple files and
 * allows UI to reason about outcomes with simple status checks.
 */
import { validateDesktopBootOutcome, type DesktopBootOutcome } from '@varin/application-client';
export type { DesktopBootOutcome } from '@varin/application-client';

type DesktopBootAvailability = { localAvailable?: boolean };

// ── UI-facing view ──

export type DesktopBootView =
  | ({ screen: 'main' } & DesktopBootAvailability)
  | ({ screen: 'main'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ screen: 'chooser' } & DesktopBootAvailability)
  | ({ screen: 'recovery'; variant: 'local-unavailable' } & DesktopBootAvailability)
  | ({ screen: 'recovery'; variant: 'remote-unreachable'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ screen: 'recovery'; variant: 'remote-incompatible'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ screen: 'recovery'; variant: 'remote-wrong-service'; hostId: string; url: string } & DesktopBootAvailability)
  | ({ screen: 'recovery'; variant: 'remote-missing'; hostId: string } & DesktopBootAvailability);

// ── Resolver inputs ──

export type DesktopBootViewInput = {
  isDesktopShell: boolean;
  bootOutcome: DesktopBootOutcome | null;
};

// ── Public API ──

/**
 * Derive the minimal UI view from the injected boot outcome.
 *
 * Returns `null` when not in desktop shell, when the outcome is not yet
 * known, or when the injected payload is malformed.
 */
export function resolveDesktopBootView(
  input: DesktopBootViewInput,
): DesktopBootView | null {
  if (!input.isDesktopShell) {
    return null;
  }

  const outcome = input.bootOutcome;
  if (!outcome) {
    return null;
  }
  const availability = outcome.localAvailable === false ? { localAvailable: false } : {};

  // Main screens - CLI or remote connection is working
  if (outcome.status === 'ok') {
    if (outcome.target === 'local') {
      return { screen: 'main', ...availability };
    } else if (outcome.target === 'remote') {
      return { screen: 'main', hostId: outcome.hostId, url: outcome.url, ...availability };
    }
  }

  // First launch - user hasn't made a choice yet
  if (outcome.target === null && outcome.status === 'not-configured') {
    return { screen: 'chooser', ...availability };
  }

  // Recovery screens - something is wrong
  if (outcome.target === 'local' && outcome.status === 'unreachable') {
    return { screen: 'chooser', ...availability };
  }

  if (outcome.target === 'remote') {
    if (outcome.status === 'unreachable') {
      return { screen: 'recovery', variant: 'remote-unreachable', hostId: outcome.hostId, url: outcome.url, ...availability };
    } else if (outcome.status === 'incompatible') {
      return { screen: 'recovery', variant: 'remote-incompatible', hostId: outcome.hostId, url: outcome.url, ...availability };
    } else if (outcome.status === 'wrong-service') {
      return { screen: 'recovery', variant: 'remote-wrong-service', hostId: outcome.hostId, url: outcome.url, ...availability };
    } else if (outcome.status === 'missing') {
      return { screen: 'recovery', variant: 'remote-missing', hostId: outcome.hostId, ...availability };
    }
  }

  // Unknown outcome — defensive null.
  return null;
}

// ── Loading gate ──

export type BootInjectionStatus =
  | 'not-injected'
  | 'malformed'
  | 'valid';

export type InitialLoadingState = {
  isDesktopShell: boolean;
  runtimeReady: boolean;
  bootOutcomeKnown: boolean;
  /**
   * Whether the resolved boot view is 'main'.
   * When false (chooser/recovery), splash dismisses on bootOutcomeKnown alone.
   * When true or absent, splash also requires the selected runtime to be ready.
   */
  bootViewIsMain?: boolean;
};

export type DesktopBootFlowRestartInput = {
  isDesktopShell: boolean;
  isDesktopLocalOriginActive: boolean;
};

/**
 * Whether the initial loading screen can be dismissed.
 *
 * Desktop shells must wait until a valid boot outcome is injected by the native host.
 * For non-main views (chooser, recovery), the splash can dismiss as soon as
 * the outcome is known — runtime readiness is not required in those flows.
 * For main views, both runtime readiness and `bootOutcomeKnown` are required.
 * Non-desktop shells only need the app to be initialized.
 */
export function canDismissInitialLoading(state: InitialLoadingState): boolean {
  if (!state.isDesktopShell) {
    return state.runtimeReady;
  }

  if (!state.bootOutcomeKnown) {
    return false;
  }

  // Non-main boot views (chooser, recovery) can dismiss without waiting for init.
  if (state.bootViewIsMain === false) {
    return true;
  }

  return state.runtimeReady;
}

/**
 * Boot/recovery UI can render in the desktop startup window before the local
 * desktop HTTP origin is active. In that state, same-origin reloads and
 * `/api/*` requests cannot recover the app, so callers must restart desktop.
 */
export function shouldRestartDesktopBootFlow(input: DesktopBootFlowRestartInput): boolean {
  return input.isDesktopShell && !input.isDesktopLocalOriginActive;
}

/**
 * Read the boot outcome injected by the native desktop host.
 * Returns `null` when not in desktop, when the outcome has not been set yet,
 * or when the injected payload is malformed.
 */
export function getInjectedBootOutcome(): DesktopBootOutcome | null {
  const status = getBootInjectionStatus();
  if (status !== 'valid') {
    return null;
  }

  const raw = (window as { __VARIN_DESKTOP_BOOT_OUTCOME__?: unknown })
    .__VARIN_DESKTOP_BOOT_OUTCOME__;

  const result = validateDesktopBootOutcome(raw);
  return result.valid ? result.outcome : null;
}

/**
 * Check the injection status of the desktop boot outcome.
 *
 * Distinguishes three states:
 * - `'not-injected'`: the global is absent or null (keep waiting)
 * - `'malformed'`: the global is present but failed validation (deterministic failure)
 * - `'valid'`: the global is present and passes validation
 */
export function getBootInjectionStatus(): BootInjectionStatus {
  if (typeof window === 'undefined') {
    return 'not-injected';
  }

  const raw = (window as { __VARIN_DESKTOP_BOOT_OUTCOME__?: unknown })
    .__VARIN_DESKTOP_BOOT_OUTCOME__;

  if (raw === undefined || raw === null) {
    return 'not-injected';
  }

  const result = validateDesktopBootOutcome(raw);
  return result.valid ? 'valid' : 'malformed';
}
