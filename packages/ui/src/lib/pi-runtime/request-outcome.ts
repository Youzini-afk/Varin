import { PiRuntimeAmbiguousRequestError, PiRuntimeRequestTimeoutError } from '@varin/runtime-client';

/** Neither a lost connection nor an elapsed response deadline proves a sent
 * mutation failed. Callers must reconcile, not restore/retry it as unsent.
 */
export const isPiRequestOutcomeUnknown = (error: unknown): boolean => (
  error instanceof PiRuntimeAmbiguousRequestError
  || error instanceof PiRuntimeRequestTimeoutError
);
