import {
  SPLASH_EXIT_DURATION_MS,
  SPLASH_HANDOFF_ATTRIBUTE,
} from '@/components/ui/varin-splash-lattice';

/**
 * Talks to the pre-paint splash in `packages/web/index.html`.
 *
 * That splash has to exist before the bundle does, so it is plain markup the app can only reach
 * through the DOM. Keeping every one of those reaches here means the element's contract — its id, its
 * status line, how it is told to leave — is stated once instead of being re-derived at each call site.
 * Two earlier call sites assigned `textContent` on the container, which deleted the mark's SVG and
 * left a bare sentence on a coloured field; writing to a dedicated status element keeps the mark.
 */

const SPLASH_ID = 'initial-loading';
const STATUS_ID = 'initial-loading-status';
/** The floor container the generated pre-paint script fills. Nothing in the app reads it after that. */
const GROUND_ID = 'initial-loading-ground';

/**
 * The splash is told to leave through the same attribute the React splash uses, so one stylesheet
 * drives both. Its exit duration comes from the module that declares the animation rather than being
 * restated here, because a copy would drift and the element would be removed mid-animation.
 */
const LEAVING_ATTRIBUTE = 'data-leaving';

type TimerHandle = ReturnType<typeof setTimeout> | number;

let removalTimer: TimerHandle | null = null;

const splashElement = (): HTMLElement | null => {
  if (typeof document === 'undefined') return null;
  return document.getElementById(SPLASH_ID);
};

/**
 * Whether the pre-paint splash still owns the screen.
 *
 * React's own loading screens check this so they do not stack a second cover, with a second fade, on
 * top of the one already painted.
 */
export const isInitialSplashPresent = (): boolean => splashElement() !== null;

/**
 * Replace the splash's status line.
 *
 * Callers pass translated text. The line is a separate element, so the mark survives and a later
 * message can replace an earlier one.
 */
export const setInitialSplashStatus = (message: string): void => {
  const status = typeof document === 'undefined' ? null : document.getElementById(STATUS_ID);
  if (!status) return;
  status.textContent = message;
};

/**
 * Run the splash's exit and remove it.
 *
 * Idempotent: startup has several paths that can each decide the app is ready, and the first one to
 * arrive should win without the others restarting the animation.
 */
export const dismissInitialSplash = (): void => {
  const element = splashElement();
  if (!element || removalTimer !== null) return;

  // The handoff background is a visual continuity aid, not a prerequisite for dismissing the cover. A
  // reduced DOM host can omit document/window framing and must still be allowed to remove the splash.
  const ownerDocument = element.ownerDocument ?? (typeof document === 'undefined' ? null : document);
  const documentElement = ownerDocument?.documentElement ?? null;
  const ownerWindow = ownerDocument?.defaultView ?? null;
  const scheduleTimeout = (callback: () => void, delayMs: number): TimerHandle => (
    ownerWindow
      ? ownerWindow.setTimeout(callback, delayMs)
      : setTimeout(callback, delayMs)
  );
  documentElement?.setAttribute(SPLASH_HANDOFF_ATTRIBUTE, 'true');
  element.setAttribute(LEAVING_ATTRIBUTE, 'true');
  removalTimer = scheduleTimeout(() => {
    // Retire the entire compositor layer before detaching its Canvas. The terminal tile frame alone
    // does not retire that layer: DOM removal and GPU resource cleanup used to happen in the same turn.
    // Keeping an explicitly transparent cover through a paint gives the application the screen first.
    element.style.opacity = '0';
    const requestFrame = ownerWindow?.requestAnimationFrame?.bind(ownerWindow);
    const remove = (): void => {
      element.remove();
      removalTimer = null;
      // Keep the active application background through the subsequent DOM/GPU cleanup paint too.
      if (requestFrame) {
        requestFrame(() => {
          requestFrame(() => documentElement?.removeAttribute(SPLASH_HANDOFF_ATTRIBUTE));
        });
      } else {
        scheduleTimeout(() => documentElement?.removeAttribute(SPLASH_HANDOFF_ATTRIBUTE), 0);
      }
    };
    if (!requestFrame) {
      remove();
      return;
    }
    requestFrame(() => {
      requestFrame(remove);
    });
  }, SPLASH_EXIT_DURATION_MS);
};

/**
 * Shared hooks for the React splash and generated pre-paint HTML hosts.
 */
export const INITIAL_SPLASH_IDS = {
  root: SPLASH_ID,
  status: STATUS_ID,
  ground: GROUND_ID,
  handoffAttribute: SPLASH_HANDOFF_ATTRIBUTE,
  leavingAttribute: LEAVING_ATTRIBUTE,
} as const;
