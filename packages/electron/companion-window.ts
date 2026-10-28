/** Native movement owns only the sender's auxiliary window, never Agent execution. */
type Bounds = { x: number; y: number; width: number; height: number };
export interface CompanionWindowOwner {
  id: number; isDestroyed(): boolean; getBounds(): Bounds; setPosition(x: number, y: number): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
}
export class CompanionWindowMovement {
  private readonly gestures = new Map<number, { pointerX: number; pointerY: number; bounds: Bounds }>();
  constructor(private readonly workArea: (bounds: Bounds) => Bounds) {}
  drag(owner: CompanionWindowOwner, input: Record<string, unknown>) {
    if (owner.isDestroyed()) throw new Error('Companion window is closed');
    const { phase, screenX, screenY } = input;
    if (!['start', 'move', 'end'].includes(String(phase))) throw new Error('Invalid companion drag phase');
    if (phase === 'end') { this.gestures.delete(owner.id); owner.setIgnoreMouseEvents(false); return; }
    if (typeof screenX !== 'number' || typeof screenY !== 'number' || !Number.isFinite(screenX) || !Number.isFinite(screenY)
      || Math.abs(screenX) > 1e6 || Math.abs(screenY) > 1e6) throw new Error('Invalid pointer coordinates');
    if (phase === 'start') {
      this.gestures.set(owner.id, { pointerX: screenX, pointerY: screenY, bounds: owner.getBounds() });
      owner.setIgnoreMouseEvents(false); return;
    }
    const gesture = this.gestures.get(owner.id);
    if (!gesture) return; // Late moves after pointercancel/capture-loss must not restart dragging.
    const bounds = { ...gesture.bounds, x: Math.round(gesture.bounds.x + screenX - gesture.pointerX), y: Math.round(gesture.bounds.y + screenY - gesture.pointerY) };
    const area = this.workArea(bounds);
    const x = Math.min(Math.max(bounds.x, area.x), Math.max(area.x, area.x + area.width - bounds.width));
    const y = Math.min(Math.max(bounds.y, area.y), Math.max(area.y, area.y + area.height - bounds.height));
    owner.setPosition(Math.round(x), Math.round(y));
  }
  forget(id: number) { this.gestures.delete(id); }
  isDragging(id: number) { return this.gestures.has(id); }
}

export function requireCompanionWindow<T extends CompanionWindowOwner & { __varinLabel?: string | undefined }>(owner: T | null): T {
  if (!owner || owner.isDestroyed() || owner.__varinLabel !== 'companion') throw new Error('This command belongs only to the companion sender window');
  return owner;
}
export function applyCompanionPassthrough(owner: CompanionWindowOwner, enabled: unknown, platform: string, dragging: boolean) {
  if (typeof enabled !== 'boolean') throw new Error('Pass-through requires an explicit boolean');
  const supported = platform === 'win32' || platform === 'darwin';
  const next = supported && enabled && !dragging;
  owner.setIgnoreMouseEvents(next, next ? { forward: true } : undefined);
  return { supported, enabled: next };
}

/** Renderer viewport coordinates are converted using the owner's actual native content DIP bounds. */
export function companionWorldRect(content: Bounds, value: unknown): Bounds {
  if (!value || typeof value !== 'object') throw new Error('Missing companion viewport');
  const input = value as Record<string, unknown>;
  const fields = ['x','y','width','height','viewportWidth','viewportHeight'] as const;
  if (!fields.every(key => typeof input[key] === 'number' && Number.isFinite(input[key]))) throw new Error('Invalid companion viewport');
  const { x, y, width, height, viewportWidth, viewportHeight } = input as Record<typeof fields[number], number>;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0 || x + width > viewportWidth || y + height > viewportHeight) throw new Error('Companion viewport escapes its sender');
  const sx = content.width / viewportWidth, sy = content.height / viewportHeight;
  return { x: Math.round(content.x + x*sx), y: Math.round(content.y + y*sy), width: Math.max(1,Math.round(width*sx)), height: Math.max(1,Math.round(height*sy)) };
}
