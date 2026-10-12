/** Disposable observations of real requests and original summary jobs, never execution authority. */
export interface ContextRequestObservation { estimatedTokens: number; identity: string }
export interface ContextTiming { durationMs: number | null; tokensPerMs: number | null; pendingTokens: number }
interface Sample {
  identity: string;
  durationMs: number | null;
  previous?: { requestId: string; revision: number; tokens: number; at: number };
  tokensPerMs: number | null;
  pendingTokens: number;
}
export class ContextPreparationTiming {
  private readonly samples = new Map<string, Sample>();
  constructor(private readonly now: () => number = () => performance.now()) {}
  clear(): void { this.samples.clear(); }
  observe(branch: string, identity: string, requestId: string, revision: number, observation: ContextRequestObservation): ContextTiming {
    let sample = this.samples.get(branch);
    if (!sample || sample.identity !== identity) {
      sample = { identity, durationMs: null, tokensPerMs: null, pendingTokens: 0 };
      this.samples.set(branch, sample);
    }
    const previous = sample.previous, at = this.now();
    if (!previous || previous.requestId !== requestId || previous.revision !== revision) {
      if (previous && previous.revision === revision && observation.estimatedTokens >= previous.tokens && at > previous.at) {
        sample.pendingTokens = observation.estimatedTokens - previous.tokens;
        sample.tokensPerMs = sample.pendingTokens / (at - previous.at);
      } else {
        sample.tokensPerMs = null;
        sample.pendingTokens = 0;
      }
      sample.previous = { requestId, revision, tokens: observation.estimatedTokens, at };
    }
    return { durationMs: sample.durationMs, tokensPerMs: sample.tokensPerMs, pendingTokens: sample.pendingTokens };
  }
  start(branch: string, identity: string): (() => void) | undefined {
    if (this.samples.get(branch)?.identity !== identity) return undefined;
    const at = this.now();
    return () => {
      const sample = this.samples.get(branch), duration = this.now() - at;
      if (sample?.identity === identity && duration > 0 && Number.isFinite(duration)) sample.durationMs = duration;
    };
  }
}
