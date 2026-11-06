import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PluginCenterAPI } from '@varin/application-client';
import type { VarinExtensionReleasePreview } from '@varin/extension-contract';
vi.mock('@varin/application-client', () => ({ getRuntimeEndpointGeneration: () => 1 }));
const { usePluginReleasePreparation } = await import('./usePluginReleasePreparation');
let root: Root, container: HTMLElement;
let controller: ReturnType<typeof usePluginReleasePreparation>;
const discard = vi.fn().mockResolvedValue(undefined);
const api = { discard } as unknown as PluginCenterAPI;
function Harness() { controller = usePluginReleasePreparation(api, 'host'); return <div>{controller.preview?.previewId}</div>; }
function deferred() { let resolve!: (value: VarinExtensionReleasePreview) => void; const promise = new Promise<VarinExtensionReleasePreview>(done => { resolve = done; }); return { promise, resolve }; }
const preview = (id: string) => ({ previewId: id, hostId: 'host' }) as VarinExtensionReleasePreview;
beforeEach(async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); discard.mockClear();
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
test('a slow first selection cannot replace the newer preview and its handle is discarded', async () => {
  const a = deferred(), b = deferred();
  await act(async () => { void controller.prepare('a', () => a.promise); void controller.prepare('b', () => b.promise); });
  await act(async () => b.resolve(preview('b'))); expect(container.textContent).toBe('b');
  await act(async () => a.resolve(preview('a'))); expect(container.textContent).toBe('b');
  expect(discard).toHaveBeenCalledWith('a');
});
test('closing the current navigation invalidates outstanding previews instead of reviving the dialog', async () => {
  const pending = deferred();
  await act(async () => { void controller.prepare('pending', () => pending.promise); controller.close(); });
  await act(async () => pending.resolve(preview('late')));
  expect(container.textContent).toBe(''); expect(discard).toHaveBeenCalledWith('late');
});
test('unmount discards an unconfirmed preview but does not discard an accepted install', async () => {
  await act(async () => controller.prepare('a', async () => preview('a')));
  await act(async () => root.render(null)); expect(discard).toHaveBeenCalledWith('a');
  await act(async () => root.render(<Harness />));
  await act(async () => controller.prepare('b', async () => preview('b')));
  controller.setInstalling(true);
  await act(async () => root.render(null)); expect(discard).not.toHaveBeenCalledWith('b');
});
