import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

type WrapperProps = React.PropsWithChildren<Record<string, unknown>>;

vi.doMock('@/components/ui/dialog', () => ({
  Dialog: ({ children, onOpenChange }: WrapperProps) => (
    <div data-dialog-locked={onOpenChange === undefined ? 'true' : 'false'}>{children}</div>
  ),
  DialogContent: ({ children, showCloseButton, ...props }: WrapperProps) => (
    <div {...props} data-close-button={String(showCloseButton)}>{children}</div>
  ),
  DialogTitle: ({ children }: WrapperProps) => <div>{children}</div>,
}));

vi.doMock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: WrapperProps) => <button {...props}>{children}</button>,
}));

vi.doMock('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: ({ children }: WrapperProps) => <div>{children}</div>,
}));

vi.doMock('@/components/chat/MarkdownRenderer', () => ({
  SimpleMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.doMock('@/lib/i18n', () => ({
  getCurrentIntlLocale: () => 'en-US',
  useI18n: () => ({ t: (key: string) => key }),
}));

const { UpdateDialog } = await import('./UpdateDialog');

describe('desktop update restart presentation', () => {
  test('locks the dialog and replaces the changelog with restart progress', () => {
    const markup = renderToStaticMarkup(
      <UpdateDialog
        open
        onOpenChange={() => undefined}
        info={{
          available: true,
          body: 'release notes should be hidden',
          currentVersion: '0.9.6',
          version: '0.9.7',
        }}
        downloading={false}
        downloaded
        restarting
        progress={null}
        error={null}
        onDownload={() => undefined}
        onRestart={() => undefined}
        runtimeType="desktop"
      />,
    );

    expect(markup).toContain('data-dialog-locked="true"');
    expect(markup).toContain('data-close-button="false"');
    expect(markup).toContain('data-update-restarting="true"');
    expect(markup).toContain('updateDialog.header.restarting');
    expect(markup).toContain('updateDialog.status.desktopRestarting');
    expect(markup).toContain('updateDialog.status.desktopRestartingHint');
    expect(markup).toContain('updateDialog.actions.restarting');
    expect(markup).not.toContain('release notes should be hidden');
  });
});
