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
