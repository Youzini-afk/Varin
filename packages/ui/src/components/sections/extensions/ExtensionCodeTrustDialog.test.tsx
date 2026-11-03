import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { settingsDict } from '@varin/application-client/settings-locales/en';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof settingsDict) => settingsDict[key] ?? key }) }));
vi.mock('@/lib/extensions/workbench-shell-transition', () => ({ selectActiveWorkbenchProfile: vi.fn() }));
vi.mock('@/lib/extensions/catalog-store', () => ({ getVarinExtensionCatalogState: vi.fn() }));
vi.mock('@/lib/extensions/surface-runtime', () => ({ varinSurfaceRuntime: { surface: 'web' } }));
vi.mock('@/components/ui/dialog', () => {
  const Content = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return { Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
    DialogContent: Content, DialogDescription: Content, DialogFooter: Content, DialogHeader: Content, DialogTitle: Content };
});
const { useExtensionCodeTrust } = await import('./ExtensionCodeTrustDialog');
let root: Root, container: HTMLElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const Harness = ({ source, execute }: { source: string; execute(source: string): void }) => {
  const trust = useExtensionCodeTrust();
  return <><button onClick={async () => {
    const captured = source;
    if (await trust.confirm({ artifacts: [{ source: { kind: 'npm', display: captured } }] })) execute(captured);
  }}>Install</button>{trust.dialog}</>;
};
test('confirmation displays the captured exact source and separates code trust from capability grants', async () => {
  const execute = vi.fn();
  await act(async () => root.render(<Harness source="@example/extension@1.0.0" execute={execute} />));
  await act(async () => container.querySelector('button')!.click());
  expect(execute).not.toHaveBeenCalled();
  expect(container.textContent).toContain('not an operating-system sandbox');
  expect(container.textContent).toContain('does not allow any capability');
  await act(async () => root.render(<Harness source="@example/extension@2.0.0" execute={execute} />));
  expect(container.querySelector('[role=dialog]')?.textContent).toContain('@example/extension@1.0.0');
  expect(container.querySelector('[role=dialog]')?.textContent).not.toContain('@example/extension@2.0.0');
  const accept = [...container.querySelectorAll('button')].find(button => button.textContent === 'Trust code and continue')!;
  await act(async () => accept.click());
  expect(execute).toHaveBeenCalledWith('@example/extension@1.0.0');
  expect(container.querySelector('[role=dialog]')).toBeNull();
});
test('closing the owning view cancels a pending code confirmation instead of admitting work', async () => {
  const execute = vi.fn();
  await act(async () => root.render(<Harness source="/workspace/local-extension" execute={execute} />));
  await act(async () => container.querySelector('button')!.click());
  await act(async () => root.render(null));
  expect(execute).not.toHaveBeenCalled();
});
