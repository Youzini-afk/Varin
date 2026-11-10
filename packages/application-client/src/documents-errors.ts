export type DocumentsFailureReason =
  | 'failed'
  | 'untrusted'
  | 'path-escape'
  | 'stale-completion'
  | 'maintenance'
  | 'unsupported'
  | 'unrepresentable'
  | 'invalid-text'
  | 'reconciliation-pending';

export class DocumentsError extends Error {
  readonly reason: DocumentsFailureReason;
  readonly status?: number;

  constructor(message: string, options: { reason?: DocumentsFailureReason; status?: number } = {}) {
    super(message);
    this.name = 'DocumentsError';
    this.reason = options.reason ?? 'failed';
    if (typeof options.status === 'number') this.status = options.status;
  }
}

export const isDocumentsError = (error: unknown): error is DocumentsError => (
  error instanceof DocumentsError
);

export const parseDocumentsFailureReason = (value: unknown): DocumentsFailureReason => {
  switch (value) {
    case 'failed':
    case 'untrusted':
    case 'path-escape':
    case 'stale-completion':
    case 'maintenance':
    case 'unsupported':
    case 'unrepresentable':
    case 'invalid-text':
    case 'reconciliation-pending':
      return value;
    default:
      return 'failed';
  }
};
