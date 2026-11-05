import type { ExternalContextUsage } from '@varin/application-client';

/** Protocol values only. Over-window occupancy is valid; missing/invalid is unknown. */
export function contextUsage(used: unknown, size: unknown): ExternalContextUsage | undefined {
  return typeof used === 'number' && Number.isSafeInteger(used) && used >= 0 &&
    typeof size === 'number' && Number.isSafeInteger(size) && size > 0
    ? { used, size } : undefined;
}

export class ContextUsage {
  value: ExternalContextUsage | undefined;
  private readonly listeners = new Set<(usage: ExternalContextUsage | undefined) => void>();
  update(used?: unknown, size?: unknown) {
    const next = contextUsage(used, size);
    if (this.value?.used === next?.used && this.value?.size === next?.size) return;
    this.value = next;
    for (const listener of this.listeners) listener(next);
  }
  subscribe = (listener: (usage: ExternalContextUsage | undefined) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}
