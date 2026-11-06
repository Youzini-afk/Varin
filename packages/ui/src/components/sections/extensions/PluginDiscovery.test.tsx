import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { settingsDict } from '@varin/application-client/settings-locales/en';
import { parseVarinExtensionDiscoveryDocument } from '@varin/extension-contract';
import type { PluginDiscoverySnapshot } from '@varin/application-client';
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof settingsDict) => settingsDict[key] ?? key }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }));
const { PluginDiscovery } = await import('./PluginDiscovery');
let root: Root, container: HTMLElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const document = parseVarinExtensionDiscoveryDocument({ schemaVersion: 1, entries: [
  { id: 'example.mail', displayName: 'Mail tools', author: 'Example Labs', categories: ['Communication'], description: 'Read mail from your own account.', keywords: ['inbox'], repository: 'https://example.com/mail', source: { kind: 'npm', display: '@example/mail', specifier: '@example/mail' } },
] });
const snapshot: PluginDiscoverySnapshot = { hostId: 'host', sources: [{ url: 'https://catalog.example/plugins.json', enabled: true, status: 'stale', error: 'Catalog offline' }], entries: document.entries.map(entry => ({ key: entry.id, entry, catalogs: ['Official'] })) };
test('cached discovery searches author and keywords and preserves failure beside results', async () => {
  const prepare = vi.fn();
  await act(async () => root.render(<PluginDiscovery snapshot={snapshot} installed={[]} query="labs inbox" category="Communication" busy={null} onPreview={prepare} onManage={vi.fn()} />));
  expect(container.textContent).toContain('Mail tools'); expect(container.textContent).toContain('Catalog offline');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/mail');
  expect(prepare).not.toHaveBeenCalled();
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Preview installation')!.click());
  expect(prepare).toHaveBeenCalledWith(document.entries[0].source, 'example.mail');
});
test('category filtering distinguishes no results from an unavailable empty catalog', async () => {
  await act(async () => root.render(<PluginDiscovery snapshot={snapshot} installed={[]} query="" category="Research" busy={null} onPreview={vi.fn()} onManage={vi.fn()} />));
  expect(container.textContent).toContain('No plugins match your search.');
  expect(container.querySelector('article')).toBeNull();
  await act(async () => root.render(<PluginDiscovery snapshot={null} installed={[]} query="" category="all" busy={null} onPreview={vi.fn()} onManage={vi.fn()} />));
  expect(container.textContent).toContain('No catalog is available.');
});
