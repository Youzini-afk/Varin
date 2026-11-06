import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PluginCenterAPI } from '@varin/application-client';
import type { VarinExtensionUpdateCheck } from '@varin/extension-contract';
const host = vi.hoisted(() => ({ revision: 1, current: true }));
vi.mock('@/lib/extensions/catalog-store', () => ({ getVarinExtensionCatalogState: () => ({ snapshot: { catalog: { revision: host.revision } } }) }));
const { usePluginUpdateChecks } = await import('./usePluginUpdateChecks');
let root: Root, container: HTMLElement;
let controller: ReturnType<typeof usePluginUpdateChecks>;
const checkUpdates = vi.fn();
const api = { checkUpdates } as unknown as PluginCenterAPI;
const isCurrent = () => host.current;
function Harness({ active = true }: { active?: boolean }) {
  controller = usePluginUpdateChecks(api, host.revision, active, isCurrent);
  return <div>{controller.checking ? 'checking' : 'idle'}:{controller.updates.map(update => `${update.status}/${update.version}`).join(',')}:{controller.error}</div>;
}
function deferred() {
  let resolve!: (value: VarinExtensionUpdateCheck[]) => void, reject!: (reason: Error) => void;
  const promise = new Promise<VarinExtensionUpdateCheck[]>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const result = (status: 'available' | 'current', version: string): VarinExtensionUpdateCheck[] => [{ extensionId: 'plugin', checkedAt: '2026-11-06T00:00:00Z', status, version }];
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  host.revision = 1; host.current = true; checkUpdates.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
test('applying an update clears the old offer and checks the changed catalog again', async () => {
  checkUpdates.mockResolvedValueOnce(result('available', '2.0.0'));
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain('available/2.0.0');
  const next = deferred(); checkUpdates.mockReturnValueOnce(next.promise);
  host.revision++;
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toBe('checking::');
  expect(checkUpdates).toHaveBeenCalledTimes(2);
  await act(async () => next.resolve(result('current', '2.0.0')));
  expect(container.textContent).toBe('idle:current/2.0.0:');
});
test('a stale source check cannot publish results or finish the newer pending check', async () => {
  const old = deferred(), replacement = deferred();
  checkUpdates.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
  await act(async () => root.render(<Harness />));
  host.revision++;
  await act(async () => root.render(<Harness />));
  await act(async () => old.resolve(result('available', '9.0.0')));
  expect(container.textContent).toBe('checking::');
  await act(async () => replacement.resolve(result('current', '1.0.0')));
  expect(container.textContent).toBe('idle:current/1.0.0:');
});
test('returning to Installed rechecks and a superseded failure cannot clear pending state', async () => {
  const old = deferred(), next = deferred();
  checkUpdates.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => root.render(<Harness active={false} />));
  expect(container.textContent).toBe('idle::');
  await act(async () => root.render(<Harness />));
  await act(async () => old.reject(new Error('old failure')));
  expect(container.textContent).toBe('checking::');
  await act(async () => next.resolve(result('current', '1.0.0')));
  expect(container.textContent).toBe('idle:current/1.0.0:');
});
test('Host changes reject completion before the old view has unmounted', async () => {
  const pending = deferred(); checkUpdates.mockReturnValueOnce(pending.promise);
  await act(async () => root.render(<Harness />));
  host.current = false;
  await act(async () => pending.resolve(result('available', '9.0.0')));
  expect(container.textContent).toBe('checking::');
});
