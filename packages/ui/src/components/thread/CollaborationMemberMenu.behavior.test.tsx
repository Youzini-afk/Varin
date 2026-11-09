import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadsAPI } from '@varin/application-client';
import type { CollaborationMember } from './collaborationFeed';
import { CollaborationComposer } from './CollaborationComposer';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';

const fixture = vi.hoisted(() => ({ read: vi.fn<() => Promise<{ members: CollaborationMember[]; more: boolean }>>() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
// Only replace popup positioning and browser layout; the composer and pagination remain real.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Menu = React.createContext({ open: false, change: (_open: boolean) => {} });
  return {
    DropdownMenu: ({ children, open, onOpenChange }: React.PropsWithChildren<{ open?: boolean; onOpenChange?(open: boolean): void }>) => {
      const [localOpen, change] = React.useState(false);
      return <Menu.Provider value={{ open: open ?? localOpen, change: onOpenChange ?? change }}>{children}</Menu.Provider>;
    },
    DropdownMenuTrigger: ({ children }: { children: React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>> }) => {
      const menu = React.useContext(Menu);
      return React.cloneElement(children, { onClick: () => menu.change(!menu.open) });
    },
    DropdownMenuContent: ({ children, ref, align: _align, side: _side, ...props }: React.HTMLAttributes<HTMLDivElement> & {
      ref?: React.Ref<HTMLDivElement>; align?: string; side?: string;
    }) => {
      const menu = React.useContext(Menu);
      const bind = React.useCallback((node: HTMLDivElement | null) => {
        if (node) Object.defineProperties(node, {
          clientHeight: { configurable: true, value: 80 },
          scrollHeight: { configurable: true, get: () => node.querySelectorAll('[role="menuitem"]').length * 40 + 24 },
        });
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }, [ref]);
      return menu.open ? <div {...props} ref={bind} role="menu">{children}</div> : null;
    },
    DropdownMenuItem: ({ children, closeOnClick: _closeOnClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { closeOnClick?: boolean }) => <button {...props} role="menuitem">{children}</button>,
  };
});

const identity = { runtime: 'agent', threadId: 'root', branchId: 'root-branch' } as const;
const member = (id: string): CollaborationMember => ({
  threadId: id, name: id === 'root' ? 'Main Agent' : id, agentId: 'worker', avatar: null,
  detail: { threadId: id, name: id, agentId: 'worker', parentThreadId: id === 'root' ? null : 'root', task: null,
    state: 'completed', current: id === 'root', branches: [{ branchId: `${id}-branch`, headId: null, activeRunId: null, latestRun: null }] },
});
function Harness() {
  const [members, setMembers] = React.useState([member('root')]);
  const [more, setMore] = React.useState(true);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const load = React.useCallback(() => {
    setLoading(true); setError(undefined);
    void fixture.read().then(page => { setMembers(previous => [...previous, ...page.members]); setMore(page.more); })
      .catch(failure => setError(failure.message)).finally(() => setLoading(false));
  }, []);
  return <CollaborationComposer api={{} as ThreadsAPI} identity={identity} draftKey="recipients" members={members}
    onSent={() => {}} moreMembers={more} loadingMembers={loading} memberError={error} loadMembers={load} />;
}
let root: Root, container: HTMLDivElement;
const menu = () => container.querySelector<HTMLDivElement>('[role="menu"]')!;
const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="collaboration.recipients"]')!;
beforeEach(() => {
  fixture.read.mockReset();
  const { document, window } = parseHTML('<html><body><div id="app"></div></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  container = document.querySelector('#app') as HTMLDivElement;
  root = createRoot(container);
  useThreadDraftStore.setState({ drafts: {} });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('loads other Agents on open, continues on scroll, and keeps selected branches when reopened', async () => {
  fixture.read.mockResolvedValueOnce({ members: [1, 2, 3, 4].map(index => member(`worker-${index}`)), more: true })
    .mockResolvedValueOnce({ members: [member('worker-5')], more: false });
  await act(async () => root.render(<Harness />));
  expect(fixture.read).not.toHaveBeenCalled();
  await act(async () => trigger().click());
  expect(fixture.read).toHaveBeenCalledOnce();
  expect(menu().textContent).not.toContain('Main Agent');
  expect(menu().textContent).not.toContain('collaboration.moreMembers');
  const worker = [...menu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'worker-1')!;
  await act(async () => worker.click());
  await act(async () => { menu().scrollTop = 100; menu().dispatchEvent(new window.Event('scroll')); });
  expect(fixture.read).toHaveBeenCalledTimes(2);
  expect(menu().textContent).toContain('worker-5');
  await act(async () => trigger().click());
  await act(async () => trigger().click());
  expect(fixture.read).toHaveBeenCalledTimes(2);
  expect(useThreadDraftStore.getState().drafts.recipients.collaboration?.targets).toEqual([
    { runtime: 'agent', threadId: 'worker-1', branchId: 'worker-1-branch' },
  ]);
});

it('stops after a member read fails and offers an inline retry', async () => {
  fixture.read.mockRejectedValueOnce(new Error('directory unavailable'))
    .mockResolvedValueOnce({ members: [member('worker-1')], more: false });
  await act(async () => root.render(<Harness />));
  await act(async () => trigger().click());
  expect(menu().querySelector('[role="alert"]')?.textContent).toBe('directory unavailable');
  expect(fixture.read).toHaveBeenCalledOnce();
  const retry = [...menu().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'common.retry')!;
  await act(async () => retry.click());
  expect(fixture.read).toHaveBeenCalledTimes(2);
  expect(menu().querySelector('[role="alert"]')).toBeNull();
  expect(menu().textContent).toContain('worker-1');
});
