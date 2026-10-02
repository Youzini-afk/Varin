import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import type { PiAgentCatalogSnapshot, PiAgentDescriptor } from '@varin/protocol';
import { I18nProvider } from '@/lib/i18n';
import { AgentList } from './AgentsPage';

const fixture = vi.hoisted(() => ({ catalog: {} as PiAgentCatalogSnapshot, targetKey: 'target',
  refresh: vi.fn(async () => {}), update: vi.fn(async (..._args: unknown[]) => ({ success: true, message: 'Saved', providerId: 'varin' })) }));
vi.mock('./agents-catalog-store', () => ({
  useAgentsCatalogState: () => ({ catalog: fixture.catalog, targetKey: fixture.targetKey, loading: false, error: null }),
  refreshAgentsCatalog: fixture.refresh, selectAgentsCatalogAgent: vi.fn(), setAgentsCatalogProviderFilter: vi.fn(), requestAgentsCatalogDefinition: vi.fn(),
}));
vi.mock('../harness/useHarnessSettings', () => ({ useHarnessSettings: () => ({ harness: null, error: null }) }));
vi.mock('@/lib/pi-runtime/agent-providers', () => ({ runPiAgentProviderAction: fixture.update }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('./PluginAgentDetails', () => ({ PluginAgentDetails: () => null }));
vi.mock('./NativeAgentDialog', () => ({ NativeAgentDialog: () => null }));
vi.mock('@/components/sections/shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children, headerEnd }: { children: React.ReactNode; headerEnd: React.ReactNode }) => <div>{headerEnd}{children}</div> }));
vi.mock('@/components/ui/switch', () => ({ Switch: ({ checked, disabled, onCheckedChange, 'aria-label': label }: { checked: boolean; disabled?: boolean; onCheckedChange(value: boolean): void; 'aria-label'?: string }) =>
  <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onCheckedChange(!checked)} /> }));

let root: Root;
let container: HTMLDivElement;
const entry = (id: string, focus: 'code' | 'research'): PiAgentDescriptor => ({
  id, name: id, providerId: 'varin', description: `Role ${id}`, kind: 'delegatable', status: 'available', source: { scope: 'user' },
  model: 'provider/model', workFocus: [focus], definition: { revision: 'owner-revision', config: {} }, actions: [{ id: 'disable', label: 'Disable' }],
});
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element); vi.stubGlobal('Node', window.Node);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  fixture.targetKey = 'target'; fixture.refresh.mockClear(); fixture.update.mockReset().mockResolvedValue({ success: true, message: 'Saved', providerId: 'varin' });
  fixture.catalog = { projectTrusted: true, diagnostics: [], providers: [{ id: 'varin', label: 'Varin', description: '', available: true, actions: [] }], agents: [
    entry('code-helper', 'code'), entry('research-helper', 'research'),
    { ...entry('plugin-helper', 'code'), providerId: 'plugin', workFocus: [], actions: [{ id: 'inspect', label: 'Inspect' }] },
  ] };
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const target = { cwd: '/workspace' };
const render = (focus: 'code' | 'research', key = 'target', runtimeKey = 'runtime-a') => act(async () => root.render(
  <I18nProvider><AgentList key={key} cwd="/workspace" runtimeKey={runtimeKey} target={target} targetKey={key} focus={focus} /></I18nProvider>,
));

test('shows agents for the current work focus alongside unscoped plugin agents, with only real toggle actions', async () => {
  await render('code');
  expect(container.querySelector('[data-agent-id="code-helper"]')).not.toBeNull();
  expect(container.querySelector('[data-agent-id="research-helper"]')).toBeNull();
  expect(container.querySelector('[data-agent-id="plugin-helper"]')).not.toBeNull();
  expect(container.querySelector('[data-agent-id="plugin-helper"] [role="switch"]')).toBeNull();
  await render('research');
  expect(container.querySelector('[data-agent-id="code-helper"]')).toBeNull();
  expect(container.querySelector('[data-agent-id="research-helper"]')).not.toBeNull();
  await act(async () => (container.querySelector('[data-agent-id="research-helper"] [role="switch"]') as HTMLButtonElement).click());
  expect(fixture.update).toHaveBeenCalledWith(target, 'varin', 'disable', 'research-helper', { expectedRevision: 'owner-revision' }, 'runtime-a');
});

test('does not apply an old mutation response to a newly selected runtime', async () => {
  let release!: (result: { success: boolean; message: string; providerId: string }) => void;
  fixture.update.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await render('code');
  await act(async () => (container.querySelector('[data-agent-id="code-helper"] [role="switch"]') as HTMLButtonElement).click());
  fixture.targetKey = 'next';
  await render('research', 'next', 'runtime-b');
  fixture.refresh.mockClear();
  await act(async () => release({ success: true, message: 'Saved', providerId: 'varin' }));
  expect(fixture.refresh).not.toHaveBeenCalled();
  expect(container.querySelector('[data-agent-id="research-helper"]')).not.toBeNull();
});
