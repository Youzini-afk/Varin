/** Shared Host cancellation: stop a caller's wait without cancelling shared work. */
export const isAbortError = (error: unknown): boolean => (
  error instanceof Error && error.name === 'AbortError'
);

export function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    // Install handlers even for a pre-aborted caller so a late shared rejection
    // cannot become an unhandled rejection.
    void promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
