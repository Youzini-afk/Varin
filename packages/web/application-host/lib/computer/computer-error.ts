import { HarnessServiceError } from '../harness/service-error.js';

export type ComputerErrorCode = 'computer-work-not-found' | 'computer-execution-stale'
  | 'computer-input-release-unconfirmed' | 'computer-runtime-format-unsupported' | 'computer-runtime-record-invalid'
  | 'computer-owner-unavailable' | 'computer-request-invalid';

/** Safe, actionable Computer-domain failures at the authenticated public boundary. */
export class ComputerError extends HarnessServiceError {
  constructor(readonly computerCode: ComputerErrorCode, message: string) {
    super(computerCode === 'computer-work-not-found' ? 'not-found' : computerCode === 'computer-request-invalid' ? 'invalid-params' : 'unavailable', message);
  }
}

/** The original release callback returned normally with released:false. Its own attempt
 * ended, while the previous physical input owner remains unconfirmed. */
export class ComputerReleaseUnconfirmed extends ComputerError {
  constructor() {
    super('computer-input-release-unconfirmed', 'The original release attempt ended without confirming the previous desktop input release');
  }
}
