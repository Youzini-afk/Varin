/** Transient world-space stool ownership; no renderer, URL or host privileges. */
export type StoolBounds = { x: number; y: number; width: number; height: number };
export type StoolPhase = 'lift' | 'landing';
export interface StoolOwner {
  id: number;
  isDestroyed(): boolean;
}
export interface StoolWindow {
  isDestroyed(): boolean;
  close(): void;
  onReady(callback: () => void): void;
}
export type StoolFactory = (bounds: StoolBounds, phase: StoolPhase, owner: StoolOwner) => StoolWindow;

/** Factory renders lift fade-out (150ms) / landing fade-in (100ms), without focus or input. */
export class CompanionStoolWindows {
  private readonly entries = new Map<number, { window: StoolWindow; timer?: ReturnType<typeof setTimeout> | undefined }>();
  constructor(private readonly create: StoolFactory) {}

  show(owner: StoolOwner, capturedBounds: StoolBounds, phase: StoolPhase): void {
    if (owner.isDestroyed()) { this.clear(owner.id); return; }
    if (phase !== 'lift' && phase !== 'landing') throw new Error('Invalid stool phase');
    // Capture native DIP geometry once. Never follow subsequent owner movement.
    const bounds = { ...capturedBounds };
    if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0)
      throw new Error('Invalid stool bounds');
    this.clear(owner.id);
    const entry = { window: this.create(bounds, phase, owner), timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.entries.set(owner.id, entry);
    entry.window.onReady(() => {
      if (this.entries.get(owner.id) !== entry || entry.window.isDestroyed() || phase !== 'lift') return;
      entry.timer = setTimeout(() => {
        // Identity guards a replacement even if an old callback was already queued.
        if (this.entries.get(owner.id) === entry) this.clear(owner.id);
      }, 150);
      entry.timer.unref?.();
    });
    // Landing remains until embedded stool takeover, cancellation, owner close or disable.
  }

  clear(ownerId: number): void {
    const entry = this.entries.get(ownerId);
    if (!entry) return;
    this.entries.delete(ownerId);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (!entry.window.isDestroyed()) entry.window.close();
  }

  clearAll(): void {
    for (const id of this.entries.keys()) this.clear(id);
  }
}
