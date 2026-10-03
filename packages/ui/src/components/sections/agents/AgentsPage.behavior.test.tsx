import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import type { PiAgentCatalogSnapshot, PiAgentDescriptor } from '@varin/protocol';
import { I18nProvider } from '@/lib/i18n';
import { AgentsPage } from './AgentsPage';
import { AgentsSidebar } from './AgentsSidebar';
import { beginAgentsCatalogTarget, refreshAgentsCatalog, useAgentsCatalogState } from './agents-catalog-store';

const fixture = vi.hoisted(() => ({ catalog: {} as PiAgentCatalogSnapshot, targetKey: 'target', runtimeKey: 'runtime-a', focus: 'code',
  update: vi.fn(async (..._args: unknown[]) => ({ success: true, message: 'Saved', providerId: 'varin' })) }));
const target = { cwd: '/workspace' };
vi.mock('@/lib/pi-runtime/agent-providers', () => ({ listPiAgentProviders: async () => fixture.catalog, runPiAgentProviderAction: fixture.update }));
vi.mock('./useAgentsPageCatalog', () => ({ useAgentsPageCatalog: () => {
  const state = useAgentsCatalogState();
  const agents = state.catalog.agents.filter(agent => state.showAllFocuses || !agent.workFocus?.length || agent.workFocus.includes(fixture.focus as 'code'));
  return { cwd: '/workspace', runtimeKey: fixture.runtimeKey, target, targetKey: fixture.targetKey,
    focus: fixture.focus, state, catalog: state.catalog, agents,
    selected: agents.find(agent => agent.id === state.selectedAgentId) ?? agents[0] ?? null,
    refresh: (afterMutation = false) => refreshAgentsCatalog(target, fixture.targetKey, afterMutation) };
} }));
vi.mock('../harness/useHarnessSettings', () => ({ useHarnessSettings: () => ({ harness: null, error: null }) }));
vi.mock('./PluginAgentDetails', () => ({ PluginAgentDetails: ({ agent }: { agent: PiAgentDescriptor | null }) => <div data-plugin-detail={agent?.id ?? 'new'} /> }));
vi.mock('./ModelSelector', () => ({ ModelSelector: () => <div data-model-selector /> }));
vi.mock('@/components/sections/shared/SettingsSidebarLayout', () => ({ SettingsSidebarLayout: ({ children, header }: { children: React.ReactNode; header: React.ReactNode }) => <aside>{header}{children}</aside> }));
vi.mock('@/components/sections/shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children, title }: { children: React.ReactNode; title: React.ReactNode }) => <main><h1>{title}</h1>{children}</main> }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <>{children}</>, SelectContent: () => null,
  SelectTrigger: () => null, SelectValue: () => null, SelectItem: () => null,
}));
vi.mock('@/components/ui/switch', () => ({ Switch: ({ checked, disabled, onCheckedChange, id }: { checked: boolean; disabled?: boolean; onCheckedChange(value: boolean): void; id?: string }) =>
  <button type="button" id={id} role="switch" aria-checked={checked} disabled={disabled} onClick={() => onCheckedChange(!checked)} /> }));

let root: Root;
let container: HTMLDivElement;
const entry = (id: string, focus: 'code' | 'research'): PiAgentDescriptor => ({
  id, name: id, providerId: 'varin', description: `Role ${id}`, kind: 'delegatable', status: 'available', source: { scope: 'user' },
  model: 'provider/model', workFocus: [focus], definition: { revision: 'owner-revision', config: { kind: 'custom', agent: {
    name: id, description: `Role ${id}`, instructions: 'Read carefully.', enabled: true, tools: ['read'], worktree: 'none', workFocus: [focus],
  } } }, actions: [{ id: 'disable', label: 'Disable' }],
});
beforeEach(async () => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element); vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('CustomEvent', window.CustomEvent);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  fixture.targetKey = 'target'; fixture.runtimeKey = 'runtime-a'; fixture.focus = 'code'; fixture.update.mockReset().mockResolvedValue({ success: true, message: 'Saved', providerId: 'varin' });
  fixture.catalog = { projectTrusted: true, diagnostics: [], providers: [{ id: 'varin', label: 'Varin', description: '', available: true, actions: [] }], agents: [
    entry('code-helper', 'code'), entry('research-helper', 'research'),
    { ...entry('plugin-helper', 'code'), providerId: 'plugin', workFocus: [], actions: [{ id: 'inspect', label: 'Inspect' }] },
  ] };
  beginAgentsCatalogTarget('reset');
  await refreshAgentsCatalog(target, fixture.targetKey);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<I18nProvider><AgentsSidebar /><AgentsPage /></I18nProvider>));

test('selects native and plugin details in the same split view, with focus filtering in the list', async () => {
  await render();
  expect(container.querySelector('aside [data-agent-id="code-helper"]')).not.toBeNull();
  expect(container.querySelector('aside [data-agent-id="research-helper"]')).toBeNull();
  expect(container.querySelector('main [data-agent-editor="native"]')).not.toBeNull();
  await act(async () => (container.querySelector('main [role="switch"]') as HTMLButtonElement).click());
  await act(async () => (container.querySelector('[data-agent-id="plugin-helper"] button') as HTMLButtonElement).click());
  expect(container.querySelector('[data-plugin-detail="plugin-helper"]')).not.toBeNull();
  await act(async () => (container.querySelector('[data-agent-id="code-helper"] button') as HTMLButtonElement).click());
  expect(container.querySelector('main [data-agent-editor="native"]')).not.toBeNull();
  expect(container.querySelector('main [role="switch"]')!.getAttribute('aria-checked')).toBe('false');
  fixture.focus = 'research';
  await render();
  expect(container.querySelector('[data-agent-id="code-helper"]')).toBeNull();
  expect(container.querySelector('[data-agent-id="research-helper"]')).not.toBeNull();
});

test('saves edits against the revision shown when editing began', async () => {
  await render();
  await act(async () => (container.querySelector('main [role="switch"]') as HTMLButtonElement).click());
  const next = { ...fixture.catalog.agents[0]!, definition: { ...fixture.catalog.agents[0]!.definition!, revision: 'outside-revision' } };
  fixture.catalog = { ...fixture.catalog, agents: [next, ...fixture.catalog.agents.slice(1)] };
  await act(async () => refreshAgentsCatalog(target, fixture.targetKey, true));
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(fixture.update).toHaveBeenCalledWith(target, 'varin', 'update', 'code-helper', {
    expectedRevision: 'owner-revision', config: expect.objectContaining({ enabled: false, instructions: 'Read carefully.' }),
  }, 'runtime-a');
});

test('does not refresh the new runtime from an old mutation response', async () => {
  let release!: (result: { success: boolean; message: string; providerId: string }) => void;
  fixture.update.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await render();
  await act(async () => (container.querySelector('main [role="switch"]') as HTMLButtonElement).click());
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  fixture.targetKey = 'next'; fixture.runtimeKey = 'runtime-b';
  await act(async () => refreshAgentsCatalog(target, fixture.targetKey));
  await render();
  await act(async () => release({ success: true, message: 'Saved', providerId: 'varin' }));
  expect(container.querySelector('main [data-agent-editor="native"]')).not.toBeNull();
});
