import type { SurfaceDisposer } from "./types.js";

export class SurfaceOwnerScope {
  readonly abortController = new AbortController();
  readonly #disposers: SurfaceDisposer[] = [];
  #disposed = false;
  #retired = false;
  #cancelled = false;
  #references = 0;
  #reason: unknown;
  readonly #retirements: Array<() => void> = [];

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get disposed(): boolean {
    return this.#retired;
  }

  onDispose(disposer: SurfaceDisposer): void {
    if (this.#retired) throw new Error("Cannot attach an effect to a disposed Surface owner scope");
    this.#disposers.push(disposer);
  }

  onRetire(disposer: () => void): void {
    if (this.#retired) throw new Error("Surface owner is retired");
    this.#retirements.push(disposer);
  }

  retain(): SurfaceDisposer {
    if (this.#disposed || this.#cancelled) throw new Error("Surface provider owner is inactive");
    this.#references += 1;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.#references -= 1;
      if (this.#retired && this.#references === 0) await this.dispose(this.#reason);
    };
  }

  async dispose(reason?: unknown, cancel = false): Promise<void> {
    if (this.#disposed) return;
    if (cancel) { this.#cancelled = true; this.abortController.abort(reason); }
    if (!this.#retired) {
      this.#retired = true;
      this.#reason = reason;
      for (const retire of this.#retirements.splice(0)) retire();
    }
    if (this.#references > 0) return;
    this.#disposed = true;
    this.abortController.abort(reason);
    const errors: unknown[] = [];
    for (let index = this.#disposers.length - 1; index >= 0; index -= 1) {
      try {
        await this.#disposers[index]?.();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#disposers.length = 0;
    if (errors.length > 0) throw new AggregateError(errors, "Surface owner cleanup failed");
  }
}
