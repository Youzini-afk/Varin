import { KernelClientError } from '../kernel/kernel-error.js';
import { sourceFailureCode } from '../kernel/source-admission-error.js';
import { ModelConfigurationError } from '../models/configuration.js';

export type CalendarPreparationStage = 'project' | 'identity' | 'source_resolution' | 'source_preparation'
  | 'source_admission' | 'model' | 'context' | 'skills' | 'child_profiles' | 'admission';

// Persist only known owner codes, never exception messages, paths, prompt bodies or
// provider responses. The stage remains useful even for an unclassified exception.
const reasons = new Set([
  'workspace_backend_unavailable', 'credential-scope-changed', 'model-configuration-changed',
  'credential-resolution-failed', 'model-channel-unavailable', 'model-channel-disabled',
  'model-unavailable', 'model-disabled', 'model-operation-unavailable', 'invalid-params',
  'operation-error', 'protocol-error', 'not-found', 'kernel-unavailable',
]);
export class CalendarPreparationError extends Error {
  readonly code: string;
  constructor(readonly stage: CalendarPreparationStage, cause: unknown) {
    const reason = sourceFailureCode(cause) ?? ((cause instanceof KernelClientError || cause instanceof ModelConfigurationError)
      && reasons.has(cause.code) ? cause.code : 'unavailable');
    const code = `calendar_preparation:${stage}:${reason}`;
    super(code, { cause });
    this.name = 'CalendarPreparationError';
    this.code = code;
  }
}
export function calendarPreparationError(error: unknown, stage: CalendarPreparationStage): CalendarPreparationError {
  return error instanceof CalendarPreparationError ? error : new CalendarPreparationError(stage, error);
}
/** Safe for logs; do not log the exception/cause object alongside this projection. */
export function calendarErrorCode(error: unknown): string {
  return error instanceof CalendarPreparationError ? error.code : 'calendar_owner_unavailable';
}
