import type { BrowserResourceBinding } from '@varin/protocol';

/** Persist identity only. A saved title/URL never establishes a live page. */
export function restoreBrowserResourceBinding(value: unknown): BrowserResourceBinding | undefined {
  if (!value || typeof value !== 'object') return;
  const binding = value as Record<string, unknown>;
  if (typeof binding.browserId !== 'string' || !binding.browserId.trim()
    || typeof binding.instanceId !== 'string' || !binding.instanceId.trim()
    || (binding.pageId !== undefined && (typeof binding.pageId !== 'string' || !binding.pageId.trim()))) return;
  return { browserId: binding.browserId, instanceId: binding.instanceId,
    ...(typeof binding.pageId === 'string' ? { pageId: binding.pageId } : {}) };
}
export const browserResourceBindingKey = (binding?: BrowserResourceBinding) => binding
  ? JSON.stringify([binding.browserId, binding.instanceId, binding.pageId ?? '']) : '';
