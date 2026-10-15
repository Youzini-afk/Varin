import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { createAgentProfilesHttpAPI, type AgentProfilesAPI, type AgentProfileSaveRequest, type AgentRuntime } from '@varin/application-client';
import { AgentSettingsService } from '../../../../../web/application-host/lib/models/settings';
import { createAgentProfilesAPI, agentProfileFailure } from '../../../../../web/application-host/lib/kernel/agent-profiles';
import { I18nProvider } from '@/lib/i18n';
import { AgentsPage } from './AgentsPage';
import { AgentsSidebar } from './AgentsSidebar';
import { beginAgentProfilesHost, selectAgentProfile, selectAgentProfilesRuntime } from './agent-profiles-store';
import { agentProfileDrafts } from './agent-profile-draft';

const fixture = vi.hoisted(() => ({ api: {} as { agentProfiles: AgentProfilesAPI; threads: { listModels: ReturnType<typeof vi.fn> } },
  piCatalog: vi.fn(), piModel: vi.fn(), host: '', writes: [] as AgentProfileSaveRequest[] }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => fixture.api }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: { currentDirectory: string }) => unknown) => select({ currentDirectory: '/workspace' }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (state: object) => unknown) => select({ projects: [], activeProjectId: null }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/lib/persistence', () => ({ reportSettingsSaveState: vi.fn() }));
vi.mock('@/components/sections/shared/SettingsSidebarLayout', () => ({ SettingsSidebarLayout: ({ children, header }: { children: React.ReactNode; header: React.ReactNode }) => <aside>{header}{children}</aside> }));
vi.mock('@/components/sections/shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children, title, headerEnd }: { children: React.ReactNode; title: React.ReactNode; headerEnd: React.ReactNode }) => <main><h1>{title}</h1>{headerEnd}{children}</main> }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
vi.mock('@/components/ui/select', () => ({ Select: ({ children }: { children: React.ReactNode }) => <>{children}</>, SelectContent: () => null, SelectTrigger: () => null, SelectValue: () => null, SelectItem: () => null }));
vi.mock('@/components/ui/switch', () => ({ Switch: ({ checked, disabled, onCheckedChange, id }: { checked: boolean; disabled?: boolean; onCheckedChange(value: boolean): void; id?: string }) =>
  <button type="button" id={id} role="switch" aria-checked={checked} disabled={disabled} onClick={() => onCheckedChange(!checked)} /> }));

let root: Root, container: HTMLDivElement, directory: string, owner: AgentProfilesAPI;
let hold: { action: 'read' | 'save'; runtime: AgentRuntime; release?: () => void } | undefined;
const originalFetch = globalThis.fetch;
const custom = { name: 'Saved helper', description: 'Existing explicit tools', instructions: 'Read carefully.', enabled: true,
  model: { providerId: 'local', modelId: 'fixture' }, worktree: 'none', workFocus: [] };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'varin-agent-settings-ui-'));
  await writeFile(join(directory, 'agent-settings.json'), JSON.stringify({ harness: {
    models: { retrievalAgent: { providerId: 'local', modelId: 'fixture' } },
    agents: { legacy: { ...custom, tools: ['read', 'external_tool'] }, split: { ...custom, name: 'Runtime helper', tools: [] } },
  } }));
  owner = createAgentProfilesAPI({ settings: new AgentSettingsService(directory, () => true),
    // Controlled registered-directory input; this test does not establish Rust IPC discovery.
    capabilities: async () => [
      { name: 'file_read', version: '1', source_requirement: 'source', default_presets: ['worker', 'retrieval'] },
      { name: 'file_write', version: '1', source_requirement: 'physical', default_presets: ['worker'] },
    ],
  });
  fixture.writes = []; fixture.piCatalog.mockClear(); fixture.piModel.mockClear(); hold = undefined;
  const { window, document } = parseHTML('<html><body></body></html>');
  Object.defineProperty(window, 'location', { value: { origin: 'http://ui.test', href: 'http://ui.test/' }, configurable: true });
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element); vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event); vi.stubGlobal('CustomEvent', window.CustomEvent);
  globalThis.fetch = async (input, init) => {
    const action = String(input).split('/').at(-1) as 'read' | 'save' | 'remove';
    const body = JSON.parse(String(init?.body));
    if (action === 'save') fixture.writes.push(body);
    try {
      const result = action === 'read' ? await owner.read(body) : action === 'save' ? await owner.save(body) : await owner.remove(body);
      if (hold?.action === action && hold.runtime === body.runtime) {
        const pending = hold;
        await new Promise<void>(resolve => { pending.release = resolve; });
      }
      return Response.json(result);
    } catch (error) {
      const failure = agentProfileFailure(error);
      return Response.json({ code: failure.code, message: failure.message }, { status: failure.status });
    }
  };
  fixture.api = { agentProfiles: createAgentProfilesHttpAPI(), threads: { listModels: vi.fn(async () => [{ providerId: 'local', modelId: 'fixture', name: 'Local fixture' }]) } };
  agentProfileDrafts.clear();
  beginAgentProfilesHost(`reset:${directory}`); selectAgentProfilesRuntime('agent');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  hold?.release?.(); hold = undefined;
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch; vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
const render = async () => { await act(async () => root.render(<I18nProvider><AgentsSidebar /><AgentsPage /></I18nProvider>)); await settle(); };
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!;
const click = async (value: HTMLElement) => { await act(async () => value.click()); await settle(); };
const edit = async (label: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const save = async () => { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await settle(); };
const persisted = async () => JSON.parse(await readFile(join(directory, 'agent-settings.json'), 'utf8'));

test('renders actual Host worker/retrieval defaults and native model catalog from native settings', async () => {
  await render();
  expect(container.querySelector('[data-agent-id="varin:builtin:worker"]')).not.toBeNull();
  expect(container.querySelector('[data-agent-id="varin:builtin:retrievalAgent"]')).not.toBeNull();
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Tools (comma or newline separated)"]')?.value).toBe('file_read, file_write');
  expect(container.querySelector('[data-tools-source="default"]')).not.toBeNull();
  expect(fixture.api.threads.listModels).toHaveBeenCalled();
  await click(container.querySelector('[data-agent-id="varin:builtin:retrievalAgent"] button')!);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Tools (comma or newline separated)"]')?.value).toBe('file_read');

});

test('preserves explicit tool names on ordinary profile edits and supports empty/reset choices', async () => {
  await render(); await act(async () => selectAgentProfile('varin:custom:legacy')); await settle();
  await click(container.querySelector('main [role="switch"]')!); await save();
  expect(Object.hasOwn(fixture.writes.at(-1)!, 'tools')).toBe(false);
  expect((await persisted()).harness.agents.legacy.tools).toEqual(['read', 'external_tool']);
  await act(async () => selectAgentProfile('varin:custom:split')); await settle();
  expect(container.querySelector('[data-tools-source="explicit"]')).not.toBeNull();
  await click(button('Reset runtime tools')); await save();
  expect((await persisted()).harness.agents.split.tools).toBeUndefined();
  await click(button('Use no tools')); await save();
  expect((await persisted()).harness.agents.split.tools).toEqual([]);
});

test('creates a custom Agent through the Host API with explicit runtime tools and all shared fields', async () => {
  await render(); await click(container.querySelector('[aria-label="Create agent"]')!);
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Tools (comma or newline separated)"]')?.value).toBe('file_read');
  await edit('Name', 'New helper'); await edit('Responsibility', 'Created here'); await edit('Instructions', 'Inspect the source.'); await edit('Tools (comma or newline separated)', 'file_read');
  await save();
  const input = fixture.writes.at(-1)!;
  expect(input.id).toBeUndefined(); expect(input.config).toMatchObject({ kind: 'custom', key: '', agent: { name: 'New helper', description: 'Created here', instructions: 'Inspect the source.', enabled: true, worktree: 'none', workFocus: [] } });
  expect(input.tools).toEqual(['file_read']);
  const added = Object.values((await persisted()).harness.agents).find((value: unknown) => (value as { name: string }).name === 'New helper');
  expect(added).toMatchObject({ tools: ['file_read'] });
  expect(container.querySelector('h1')?.textContent).toBe('New helper');
});

test('keeps draft revisions across refresh; conflicts do not silently retry or overwrite', async () => {
  await render(); await act(async () => selectAgentProfile('varin:custom:legacy')); await settle();
  await click(container.querySelector('main [role="switch"]')!);
  const before = await owner.read({ runtime: 'agent' });
  const external = before.profiles.find(profile => profile.id === 'varin:custom:legacy')!;
  if (external.config.kind !== 'custom') throw new Error('Expected custom fixture');
  await owner.save({ runtime: 'agent', expectedRevision: before.revision, id: external.id, config: { ...external.config, agent: { ...external.config.agent, description: 'External change' } } });
  await click(button('Refresh'));
  await act(async () => selectAgentProfile('varin:custom:legacy')); await settle();
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  await save();
  expect(fixture.writes).toHaveLength(1); expect(fixture.writes[0]!.expectedRevision).toBe(before.revision);
  expect(container.textContent).toContain('Agent settings changed. Reload them before saving.');
  expect((await persisted()).harness.agents.legacy.enabled).toBe(true);
  await click(button('Discard draft'));
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  expect(container.querySelector<HTMLInputElement>('[aria-label="Responsibility"]')?.value).toBe('External change');
});
