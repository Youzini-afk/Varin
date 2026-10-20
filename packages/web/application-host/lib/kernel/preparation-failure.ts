import { sourceFailureCode } from './source-admission-error.js';
import type { SourceFailureCode } from './protocol.generated.js';

export type PreparationFailureCode = SourceFailureCode | 'binding_changed' | 'credentials_unavailable' | 'preparation_failed';

/** Preserve the owner's diagnostic separately from the stable recovery category. */
export function preparationFailure(error: unknown, stage: string): { code: PreparationFailureCode; detail: string } {
  const originalCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  const code = sourceFailureCode(error) ?? (['credential-scope-changed', 'model-configuration-changed'].includes(originalCode) ? 'binding_changed'
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
  return { code, detail: message ? `${stage}: ${message}` : `${stage}: ${originalCode || code}` };
}
