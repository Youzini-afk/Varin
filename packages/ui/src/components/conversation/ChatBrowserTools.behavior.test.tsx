import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/useUIStore';
import { ChatBrowserTool } from './ChatBrowserTools';
import type { ToolViewProps } from './toolViewTypes';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/desktop', () => ({ isDesktopLocalOriginActive: () => false }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./ToolDisclosure', () => ({ ToolDisclosure: ({ children }: React.PropsWithChildren) => <div>{children}</div>, ToolStatus: () => null }));
vi.mock('./ChatResourceTools', () => ({ ToolFileLink: () => null, ToolResultNotice: () => null }));
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; useUIStore.setState({ contextPanelByDirectory: {} }); vi.unstubAllGlobals(); });

it('opens the resource-bound tool page on a web client without a workspace or local browser', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container);
  const binding = { browserId: 'remote-browser', instanceId: 'real-instance' };
  const props: ToolViewProps = { call: { type: 'toolCall', id: 'call', name: 'browser_tabs', arguments: {} }, cwd: '', status: 'success', output: null, details: null,
    result: { content: [], isError: false, role: 'toolResult', timestamp: 0, toolCallId: 'call', toolName: 'browser_tabs', details: { binding, pages: [{ pageId: 'real-tab', title: 'Real page', url: 'https://original.test' }] } } };
  await act(async () => { root = createRoot(container); root.render(<ChatBrowserTool {...props} />); });
  const button = container.querySelector('button')!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(useUIStore.getState().contextPanelByDirectory['']?.tabs[0]).toMatchObject({
    mode: 'browser', browserBinding: { ...binding, pageId: 'real-tab' }, targetPath: 'https://original.test',
  });
});
