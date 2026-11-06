import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { settingsDict } from '@varin/application-client/settings-locales/en';
import type { PluginCenterAPI } from '@varin/application-client';
import type { VarinExtensionReleasePreview } from '@varin/extension-contract';
const harness = vi.hoisted(() => ({ generation: 1, hostId: 'host-a', revision: 7, confirm: vi.fn(), refresh: vi.fn() }));
vi.mock('@varin/application-client', () => ({ getRuntimeEndpointGeneration: () => harness.generation }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof settingsDict) => settingsDict[key] ?? key }) }));
vi.mock('./ExtensionCodeTrustDialog', () => ({ useExtensionCodeTrust: () => ({ confirm: harness.confirm, dialog: null }) }));
vi.mock('@/lib/extensions/catalog-store', () => ({ getVarinExtensionCatalogState: () => ({ snapshot: { catalog: { hostId: harness.hostId, revision: harness.revision } } }), refreshVarinExtensionCatalog: harness.refresh }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }));
vi.mock('@/components/ui/dialog', () => {
  const Content = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return { Dialog: Content, DialogContent: Content, DialogDescription: Content, DialogFooter: Content, DialogHeader: Content, DialogTitle: Content };
});
const { PluginReleasePreview } = await import('./PluginReleasePreview');
let root: Root, container: HTMLElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  harness.generation = 1; harness.hostId = 'host-a'; harness.revision = 7; harness.confirm.mockReset(); harness.refresh.mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const preview: VarinExtensionReleasePreview = { previewId: 'pinned', catalogRevision: 7, hostId: 'host-a', source: { kind: 'npm', display: 'example' }, manifest: { schemaVersion: 1, id: 'example', version: '1.0.0', engines: { varin: '*' } }, version: '1.0.0', integrity: 'reviewed-content', sourceChanged: false, warnings: [] };
const clickInstall = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Install reviewed package')!.click();
test('the pinned package is installed only after code trust with its captured Host and revision', async () => {
  const install = vi.fn().mockResolvedValue({}); const complete = vi.fn(); harness.confirm.mockResolvedValue(true);
  await act(async () => root.render(<PluginReleasePreview preview={preview} api={{ install } as unknown as PluginCenterAPI} onClose={vi.fn()} onInstalled={complete} />));
  expect(install).not.toHaveBeenCalled(); await act(async () => clickInstall());
  expect(harness.confirm).toHaveBeenCalledWith({ artifacts: [{ extensionId: 'example', version: '1.0.0', integrity: 'reviewed-content', source: preview.source }] });
  expect(install).toHaveBeenCalledWith({ previewId: 'pinned', expectedHostId: 'host-a', expectedRevision: 7, replaceSource: false });
  expect(complete).toHaveBeenCalledOnce();
});
test('switching Host during confirmation cannot send installation to the next Host', async () => {
  let resolve!: (accepted: boolean) => void; harness.confirm.mockImplementation(() => new Promise(done => { resolve = done; }));
  const install = vi.fn();
  await act(async () => root.render(<PluginReleasePreview preview={preview} api={{ install } as unknown as PluginCenterAPI} onClose={vi.fn()} onInstalled={vi.fn()} />));
  await act(async () => clickInstall()); harness.generation++; harness.hostId = 'host-b';
  await act(async () => resolve(true));
  expect(install).not.toHaveBeenCalled(); expect(container.textContent).toContain('changed');
});

const { PluginUpdateStatus } = await import('./PluginUpdateStatus');
test('current versions retain explicit content preview and pinned upstream release notes', async () => {
  const open = vi.fn();
  await act(async () => root.render(<PluginUpdateStatus update={{ extensionId: 'example', checkedAt: '2026-01-01T00:00:00Z', status: 'current', version: '1.0.0' }} busy={false} onCheck={vi.fn()} onPreview={open} />));
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Preview release content')!.click());
  expect(open).toHaveBeenCalledOnce();
  const notes = 'https://github.com/author/plugin/releases/tag/v1.0.0';
  await act(async () => root.render(<PluginReleasePreview preview={{ ...preview, releaseNotesUrl: notes }} api={{} as PluginCenterAPI} onClose={vi.fn()} onInstalled={vi.fn()} />));
  expect(container.querySelector('a')?.getAttribute('href')).toBe(notes);
  expect(container.querySelector('a')?.textContent).toBe('Release notes');
});
