/** Opt-in, content-free kernel request counters. Disabled requests allocate no timer/sample.
 * Histogram buckets are 1/8 octaves; quantiles report the bucket's upper bound in ms. */
class LatencyHistogram {
  private readonly buckets = new Map<number, number>();
  count = 0;
  totalMs = 0;
  maxMs = 0;
  add(ms: number): void {
    const bucket = Math.ceil(Math.log2(Math.max(ms, 0.001)) * 8);
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + 1);
    this.count++; this.totalMs += ms; this.maxMs = Math.max(this.maxMs, ms);
  }
  private percentile(quantile: number): number {
    let remaining = Math.ceil(this.count * quantile);
    for (const [bucket, count] of [...this.buckets].sort(([left], [right]) => left - right)) {
      remaining -= count;
      if (remaining <= 0) return 2 ** (bucket / 8);
    }
    return 0;
  }
  snapshot() { return {count: this.count, totalMs: this.totalMs, maxMs: this.maxMs, p50Ms: this.percentile(0.5), p95Ms: this.percentile(0.95)}; }
}
export interface KernelRequestMeasurement { admitted(): void; finished(disconnected?: boolean): void }
export class KernelPerformance {
  private readonly methods = new Map<string, {count: number; disconnected: number; wait: LatencyHistogram; roundTrip: LatencyHistogram}>();
  start(method: string): KernelRequestMeasurement {
    let metrics = this.methods.get(method);
    if (!metrics) { metrics = {count: 0, disconnected: 0, wait: new LatencyHistogram(), roundTrip: new LatencyHistogram()}; this.methods.set(method, metrics); }
    metrics.count++;
    const entry = metrics, queued = performance.now();
    let admitted: number | undefined, finished = false;
    return {
      admitted() { admitted = performance.now(); entry.wait.add(admitted - queued); },
      finished(disconnected = false) {
        if (finished) return;
        finished = true;
        if (disconnected) entry.disconnected++;
        if (admitted !== undefined) entry.roundTrip.add(performance.now() - admitted);
      },
    };
  }
  snapshot() { return Object.fromEntries([...this.methods].map(([method, entry]) => [method, {count: entry.count, disconnected: entry.disconnected, windowWait: entry.wait.snapshot(), roundTrip: entry.roundTrip.snapshot()}])); }
  reset(): void { this.methods.clear(); }
}
export const kernelPerformance = process.env.VARIN_PERF === '1' ? new KernelPerformance() : undefined;
