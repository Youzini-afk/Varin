import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';
import { IndexDirectories } from './IndexDirectories';
import type { SemanticIndexStatus } from './semantic-index-api';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string, values?: Record<string, unknown>) => {
  if (key === 'index.directories.indexedFiles') return `Indexed ${values?.count}/${values?.total} documents`;
  if (key === 'index.directories.checkedFiles') return `Checked ${values?.count}/${values?.total} files this pass`;
  if (key === 'settings.page.harness.index.progress.documents') return `${values?.count} indexed documents`;
  return key;
} }) }));
vi.mock('@/components/session/DirectoryExplorerDialog', () => ({ DirectoryExplorerDialog: () => null }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section> }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: () => null, DialogContent: () => null, DialogHeader: () => null, DialogTitle: () => null,
  DialogDescription: () => null, DialogFooter: () => null,
}));

const snapshot = (): SemanticIndexStatus => ({
  directories: { revision: 'r1', entries: [{ path: '/project', workspaceId: 'w', state: 'active',
    project: true, manual: false, checking: false, busy: false }] },
  config: { storageDirectory: null, concurrentRequests: 1, requestIntervalMs: 0 },
  activeConfig: { storageDirectory: null, concurrentRequests: 1, requestIntervalMs: 0 },
  revision: 'r1', activeDirectory: '/index', configuredDirectory: '/index',
  restartRequired: false, bytes: 1, retained: [],
  roots: [{ workspaceId: 'w', root: '/project', binding: 'ready', indexingEnabled: true,
    status: { status: 'ready', coverage: 'partial', lifecycle: 'building', publishedDocuments: 50 },
    progress: { phase: 'processing', processedFiles: 3, totalFiles: 100, publishedDocuments: 49 } }],
});
const render = (status: SemanticIndexStatus) => parseHTML('<html><body>' + renderToStaticMarkup(
  <IndexDirectories status={status} refresh={async () => {}} />,
) + '</body></html>').document;

describe('index progress presentation', () => {
  it('keeps cleanup retry enabled after failure and hides stale scan failures during cleanup', () => {
    const status = snapshot();
    const entry = status.directories.entries[0]!;
    entry.state = 'deleting';
    entry.error = 'Semantic store shutdown failed';
    const failed = render(status);
    const retry = [...failed.querySelectorAll('button')].find(button => button.textContent?.includes('index.directories.retryRemoval'));
    expect(retry?.hasAttribute('disabled')).toBe(false);
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain(entry.error);
    entry.busy = true;
    status.roots[0]!.progress!.error = entry.error;
    const running = render(status);
    expect(running.querySelector('[role="alert"]')).toBeNull();
    expect(running.body.textContent).not.toContain('index.directories.retryRemoval');
    expect(running.querySelector('progress')).toBeNull();
    entry.removal = { phase: 'symbols', completed: 64, total: 100, unit: 'files' };
    const removing = render(status);
    expect(removing.body.textContent).toContain('index.directories.cleanup.symbols');
    expect(removing.body.textContent).toContain('index.directories.cleanup.files');
    expect(removing.querySelector('progress')?.getAttribute('value')).toBe('64');
    expect(removing.querySelector('progress')?.getAttribute('max')).toBe('100');
  });

  it('offers cleanup without restarting retired indexes', () => {
    const document = render(snapshot());
    expect(document.body.textContent).toContain('index.directories.cached');
    expect(document.body.textContent).toContain('index.directories.remove');
    expect(document.body.textContent).not.toContain('index.directories.resume');
    expect(document.body.textContent).not.toContain('index.directories.check');
    expect(document.querySelector('progress')).toBeNull();
  });
});
