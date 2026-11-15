import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { ThreadSwitcherDropdown } from './ThreadSwitcherDropdown';
import type { SidebarConversation } from '@/components/conversation/sidebarCatalog';
import opencode from '@/assets/harness-logos/opencode.svg';
import codex from '@/assets/harness-logos/codex.svg';

const state = vi.hoisted(() => ({ sessions: [] as SidebarConversation[], open: vi.fn(async () => {}) }));
vi.mock('@/components/conversation/sidebarCatalog', () => ({ useSidebarCatalog: () => ({ activeSessions: state.sessions, attentionBySession: {} }) }));
vi.mock('@/stores/useExternalAgentStore', () => ({ openConversationFromNavigation: state.open,
  useExternalAgentStore: (select: (state: object) => unknown) => select({ selectedId: 'manual' }) }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: (select: (state: object) => unknown) => select({ selectedIdentity: null }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (state: object) => unknown) => select({ projects: [] }) }));
vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ startThreadFromNavigation: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: ({ name }: { name: string }) => <span data-icon={name} /> }));
vi.mock('@/components/ui/AgentAvatar', () => ({ AgentAvatar: ({ identity }: { identity: string }) => <span data-native-avatar={identity} /> }));
vi.mock('@/components/ui/dropdown-menu', () => {
  const Part = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return { DropdownMenu: Part, DropdownMenuTrigger: Part, DropdownMenuContent: Part, DropdownMenuLabel: Part,
    DropdownMenuSeparator: () => null, DropdownMenuItem: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} /> };
});
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  state.open.mockClear();
  state.sessions = [
    { id: 'native', name: 'Native', avatar: 'role-portrait', lead: true },
    { id: 'manual', name: 'Renamed manual', harness: 'acp', configurationId: 'opencode', busy: true },
    { id: 'delegated', name: 'Delegated', harness: 'codex', configurationId: 'codex', parentId: 'native' },
  ].map(value => ({ firstMessage: '', cwd: '/work', createdAt: '2026-11-15', updatedAt: '2026-11-15',
    pinned: false, busy: false, unread: false, projectIds: [], branchId: '', branches: [], lead: false, ...value } as SidebarConversation));
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('keeps external logos beside independent activity, highlights the actual external selection and opens that conversation', async () => {
  await act(async () => root.render(<ThreadSwitcherDropdown><button>Switch</button></ThreadSwitcherDropdown>));
  const row = (name: string) => [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith(name))!;
  expect(row('Native').querySelector('[data-native-avatar="native"]')).not.toBeNull();
  expect(row('Renamed manual').querySelector('img')?.getAttribute('src')).toBe(opencode);
  expect(row('Renamed manual').querySelector('[data-icon="loader-4"]')).not.toBeNull();
  expect(row('Renamed manual').className).toContain('bg-interactive-active');
  expect(row('Delegated').querySelector('img')?.getAttribute('src')).toBe(codex);
  expect(row('Delegated').querySelector('[data-native-avatar]')).toBeNull();
  await act(async () => row('Renamed manual').click());
  expect(state.open).toHaveBeenCalledExactlyOnceWith({ directory: '/work', threadId: 'manual' });
});
