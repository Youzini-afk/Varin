import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { mergeHarnessSettings } from '@varin/protocol';

const fixture = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('@varin/application-client', async importOriginal => ({ ...await importOriginal<object>(), createEmbeddingRequestsHttpAPI: () => fixture }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./RetrievalSettings', () => ({ InferenceSettings: () => <p>Embedding model</p> }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, SelectValue: () => null,
}));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) =>
  <input {...props} onInput={event => onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>)} /> }));
const { EmbeddingSettings } = await import('./EmbeddingSettings');
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.unstubAllGlobals(); vi.resetAllMocks(); });

it('preserves a failed request-settings draft and saves against the last acknowledged revision', async () => {
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('Event', window.Event); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const config = { concurrentRequests: 1, requestIntervalMs: 0 };
  fixture.read.mockResolvedValue({ config, activeConfig: config, revision: 'original', restartRequired: false });
  fixture.save.mockRejectedValueOnce(new Error('changed elsewhere'));
  const container = document.getElementById('app')!;
  root = createRoot(container);
  await act(async () => root!.render(<EmbeddingSettings harness={mergeHarnessSettings({}, {})} update={vi.fn()} />));
  const input = container.querySelector<HTMLInputElement>('input')!;
  const type = async (value: string) => act(async () => { input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  const click = async (label: string) => act(async () => {
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === label);
    expect(button).toBeTruthy(); button!.click();
  });
  await type('4');
  await click('settings.common.actions.saveChanges');
  expect(fixture.save).toHaveBeenCalledWith({ concurrentRequests: 4, requestIntervalMs: 0, localCpuMode: 'auto', localCpuThreads: null }, 'original');
  expect(input.value).toBe('4'); expect(container.textContent).toContain('changed elsewhere');
  await click('settings.common.actions.cancel'); expect(input.value).toBe('1');
  fixture.save.mockResolvedValue({ config: { ...config, concurrentRequests: 2 }, activeConfig: config, revision: 'saved', restartRequired: true });
  await type('2'); await click('settings.common.actions.saveChanges');
  expect(container.textContent).toContain('settings.page.harness.embeddings.requests.restartRequired');
  expect(container.textContent).not.toContain('assistant.unsaved');
});
