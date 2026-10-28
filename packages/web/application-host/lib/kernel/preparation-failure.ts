import { sourceFailureCode } from './source-admission-error.js';
import { SourceCaptureError } from '../harness/working-state/source-preparation.js';
import type { ExecutionError, SourceFailureCode } from './protocol.generated.js';

export type PreparationFailureCode = SourceFailureCode | 'binding_changed' | 'credentials_unavailable' | 'preparation_failed' | 'workspace_backend_unavailable';

/** Preserve the owner's diagnostic separately from the stable recovery category. */
export function preparationFailure(error: unknown, stage: string): { code: PreparationFailureCode; detail: string; failure?: ExecutionError } {
  const originalCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  const code = (error instanceof SourceCaptureError ? 'source_changed' : sourceFailureCode(error)) ?? (originalCode === 'workspace_backend_unavailable' ? originalCode : ['credential-scope-changed', 'model-configuration-changed'].includes(originalCode) ? 'binding_changed'
    : originalCode.startsWith('credential-') ? 'credentials_unavailable' : 'preparation_failed');
  const messages: string[] = [];
  const seen = new Set<Error>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (cause.message && !messages.includes(cause.message)) messages.push(cause.message);
    cause = cause.cause;
  }
  if (!messages.length && typeof error === 'string') messages.push(error);
  const message = messages.join(': ');
  const detail = message ? `${stage}: ${message}` : `${stage}: ${originalCode || code}`;
  const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
  return { code, detail, failure: { code: originalCode || code, message: message || originalCode || code,
    details: details && typeof details === 'object' && !Array.isArray(details) ? { stage, ...details } : { stage, ...(details === undefined ? {} : { cause: details }) } } };
}
