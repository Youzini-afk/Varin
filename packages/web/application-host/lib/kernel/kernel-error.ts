import type { KernelError } from './protocol.generated.js';

export class KernelClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: KernelError | { code: string; message: string; retryable?: boolean }) {
    super(error.message);
    this.name = 'KernelClientError';
    this.code = error.code;
    this.retryable = error.retryable ?? false;
  }
}

/** A fact about one original request, never inferred from its error code or message. */
export class KernelRequestError extends KernelClientError {
  constructor(error: Error | { code: string; message: string; retryable?: boolean }, readonly method: string,
    readonly settlement: 'not_dispatched' | 'response') {
    super(error instanceof Error && !(error instanceof KernelClientError)
      ? { code: 'kernel-error', message: error.message } : error);
    this.name = 'KernelRequestError';
  }
}
