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
  <IndexDirectories status={status} draft={null} edit={() => {}} refresh={async () => {}} />,
) + '</body></html>').document;

describe('index progress presentation', () => {
  it('shows the saved index completion separately from the current check counter', () => {
    const document = render(snapshot());
    expect(document.body.textContent).toContain('Indexed 50/100 documents');
    expect(document.body.textContent).toContain('Checked 3/100 files this pass');
    expect(document.querySelector('progress')?.getAttribute('value')).toBe('50');
  });

  it('keeps the saved count visible before a restarted directory inventory knows its total', () => {
    const status = snapshot();
    status.roots[0]!.progress = { phase: 'enumerating', processedFiles: 0, totalFiles: 0 };
    const document = render(status);
    expect(document.body.textContent).toContain('50 indexed documents');
    expect(document.body.textContent).not.toContain('Checked 0/');
  });
});
