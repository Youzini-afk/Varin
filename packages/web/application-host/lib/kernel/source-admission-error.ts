/** Source-owner failures projected into the existing launch and tool error paths. */
import { threadSourceFailureMessage } from '@varin/application-client';
import { DocumentUntrustedError, DocumentWorkspaceUnavailableError, DocumentWorkspaceUnregisteredError } from '../documents/errors.js';
import { KernelClientError } from './kernel-error.js';
import type { SourceFailureCode } from './protocol.generated.js';

export class SourceAdmissionError extends Error {
  constructor(readonly code: SourceFailureCode, options?: ErrorOptions) {
    super(threadSourceFailureMessage(code), options);
    this.name = 'SourceAdmissionError';
  }
}
/** Only original typed owners classify failures. A matching property on an arbitrary error is not authority. */
export function sourceFailureCode(error: unknown): SourceFailureCode | undefined {
  if (error instanceof SourceAdmissionError) return error.code;
  if (error instanceof DocumentWorkspaceUnregisteredError) return 'source_registration_missing';
  if (error instanceof DocumentUntrustedError) return 'source_authority_denied';
  if (error instanceof DocumentWorkspaceUnavailableError) return 'source_unavailable';
  if (error instanceof KernelClientError && ['unauthorized', 'kernel-grant-stale'].includes(error.code)) return 'source_authority_denied';
  return undefined;
}
/** Called only around the original Storage source reader, never around unrelated preparation. */
export function sourceReadError(error: unknown): unknown {
  if (sourceFailureCode(error)) return error;
  return error instanceof KernelClientError && ['storage-error', 'operation-error'].includes(error.code)
    ? new SourceAdmissionError('source_unavailable', { cause: error }) : error;
}
