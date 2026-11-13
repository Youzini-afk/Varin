import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UsageSummary, UsageSummaryRow } from '@varin/protocol';
const api = vi.hoisted(() => ({ summary: vi.fn(), read: vi.fn(), refreshDirectory: vi.fn(), observe: vi.fn(), setSettingsPage: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<object>(), createUsageHttpAPI: () => api, createModelConnectionsHttpAPI: () => api }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: api }) }));
vi.mock('@/lib/i18n', () => { const t = (key: string) => key; return { useI18n: () => ({ t }) }; });
vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ openThreadFromNavigation: vi.fn() }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: { getState: () => ({ resolveThread: vi.fn() }) } }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: Object.assign((read: (state: { isMobile: boolean }) => unknown) => read({ isMobile: false }), { getState: () => ({ setSettingsPage: api.setSettingsPage }) }) }));
vi.mock('../shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children, title, headerEnd }: { children: React.ReactNode; title: React.ReactNode; headerEnd: React.ReactNode }) => <main><h1>{title}</h1>{headerEnd}{children}</main> }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: () => null, DialogContent: () => null, DialogTitle: () => null }));
vi.mock('@/components/thread/ThreadTokenUsage', () => ({ ThreadTokenUsage: () => null }));
import { UsageSettingsPage } from './UsageSettingsPage';
import { dayKey } from './usage-data';
let root: Root, container: HTMLElement;
const value = { known: '10', missing: 0 };
const row = { day: dayKey(new Date()), kind: 'conversation', purpose: null, providerId: 'channel', modelId: 'measured', providerFamily: 'openai-responses', billing: 'metered', priced: true, priceSources: ['custom'], measurement: 'actual', requests: 1,
  inputTokens: value, completeInputTokens: value, outputTokens: value, cachedInputTokens: { known: '0', missing: 0 }, cacheWriteTokens: value, reasoningTokens: value,
  costUsd: 2, referenceUsd: 0, costUnknownRequests: 0, currentPriceRequests: 0, cacheSavedUsd: 0, prices: [] } as UsageSummaryRow;
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.getElementById('root')!; root = createRoot(container);
  api.summary.mockReset().mockResolvedValue({ throughCursor: 5, recordingStartedAtMs: Date.now(), threads: [], external: [], rows: [row, { ...row, modelId: 'unpriced', priced: false, costUsd: 0 }, { ...row, modelId: 'subscription', billing: 'subscription', costUsd: 0, referenceUsd: 100 }] } satisfies UsageSummary);
  api.read.mockReset().mockResolvedValue({ channels: [{ id: 'channel', name: 'Actual channel', models: [] }] });
  api.observe.mockReset().mockImplementation((_cursor, _listener, {signal}) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true})));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it('renders real usage and missing-price labels, then changes the calendar query from the range control', async () => {
  await act(async () => root.render(<UsageSettingsPage />));
  expect(container.querySelector('h1')?.textContent).toBe('usage.title');
  expect(container.querySelector('.usage-total strong')?.textContent).toContain('2.00');
  expect(container.querySelector('.usage-total strong')?.textContent).not.toContain('100');
  expect(container.querySelector('.usage-total sup')?.textContent).toBe('+');
  expect(container.textContent).toContain('Actual channel'); expect(container.textContent).toContain('usage.unpriced');
  const control = [...container.querySelectorAll('button')].find(button => button.textContent === 'usage.7d');
  await act(async () => control!.click());
  expect(api.summary.mock.calls.at(-1)![0].days).toHaveLength(14);
  expect(api.observe).toHaveBeenCalledWith(null, expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
