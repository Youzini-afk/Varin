/** Transport credits, not a product request limit. Callers wait before encoding
 * an envelope; a credit returns only on native acknowledgement or disconnect. Long process
 * interactions acknowledge body admission separately from their final effect. */
export class KernelRequestWindow {
  private used = 0;
  private failure: Error | undefined;
  private readonly waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    removeAbort: () => void;
  }> = [];
  private readonly idle: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid kernel request window");
  }

  acquire(signal?: AbortSignal, aborted: () => Error = () => new DOMException("Request cancelled", "AbortError")): Promise<() => void> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        waiter.removeAbort();
        reject(aborted());
      };
      const waiter = { resolve, reject, removeAbort: () => signal?.removeEventListener("abort", onAbort) };
      this.waiting.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    while (!this.failure && this.used < this.capacity && this.waiting.length) {
      const waiter = this.waiting.shift()!;
      waiter.removeAbort();
      this.used++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.used--;
        this.pump();
        if (!this.used) for (const resolve of this.idle.splice(0)) resolve();
      });
    }
  }

  whenIdle(): Promise<void> {
    return this.used ? new Promise(resolve => this.idle.push(resolve)) : Promise.resolve();
  }

  close(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.waiting.splice(0)) {
      waiter.removeAbort();
      waiter.reject(this.failure);
    }
  }
}
