import type { HarnessFastDecisionResult } from '@varin/protocol';

/** The original inference owner retains accounted partial results on failure. */
export class DecisionInferenceFailure extends Error {
  constructor(message: string, readonly result?: HarnessFastDecisionResult, readonly cancelled = false) {
    super(message);
    this.name = 'DecisionInferenceFailure';
  }
}
