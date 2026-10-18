import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentSettingsSnapshot, createModelConnectionsHttpAPI } from '@varin/application-client';
import type { VarinEvent } from '@/lib/varinEvents';
import { ThreadPermissionControl } from './ThreadPermissionControl';

const fixture = vi.hoisted(() => ({ host: 0, endpoints: new Set<() => void>(), events: new Set<(event: VarinEvent) => void>(),
  read: vi.fn(), write: vi.fn() }));
vi.mock('@varin/application-client', () => ({
  getRuntimeKey: () => `host-${fixture.host}`, getRuntimeEndpointGeneration: () => fixture.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.endpoints.add(listener); return () => fixture.endpoints.delete(listener); },
  createModelConnectionsHttpAPI: (host: number) => ({
    readSettings: (cwd?: string) => fixture.read(host, cwd),
    updateSettings: (input: Parameters<ReturnType<typeof createModelConnectionsHttpAPI>['updateSettings']>[0]) => fixture.write(host, input),
  }),
}));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: VarinEvent) => void) => {
  fixture.events.add(listener); return () => fixture.events.delete(listener);
} }));
vi.mock('@/lib/persistence', () => ({ reportSettingsSaveState: vi.fn() }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: () => '/unrelated-navigation-project' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/ui/dropdown-menu', () => {
  const Choice = React.createContext({ value: '', onValueChange: (_value: string) => {} });
  const Section = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return { DropdownMenu: Section, DropdownMenuTrigger: Section, DropdownMenuContent: Section, DropdownMenuLabel: Section,
    DropdownMenuRadioGroup: ({ children, ...value }: React.PropsWithChildren<{ value: string; onValueChange(value: string): void }>) => <Choice.Provider value={value}>{children}</Choice.Provider>,
    DropdownMenuRadioItem: ({ value, disabled, children }: React.PropsWithChildren<{ value: string; disabled: boolean }>) => {
      const choice = React.useContext(Choice);
      return <button type="button" role="menuitemradio" aria-checked={choice.value === value} disabled={disabled} onClick={() => choice.onValueChange(value)}>{children}</button>;
    },
  };
});

let root: Root, container: HTMLDivElement, settings: AgentSettingsSnapshot;
beforeEach(() => {
  vi.clearAllMocks(); fixture.host += 1;
  settings = { global: { harness: { permissions: { mode: 'normal', rules: [{ tool: 'example', decision: 'ask' }] }, shell: 'auto' } },
    globalRevision: 'initial', project: {}, projectRevision: 'project', projectTrusted: false };
  fixture.read.mockImplementation(async () => structuredClone(settings));
  fixture.write.mockImplementation(async (_host, input) => {
    settings = { ...settings, global: { ...settings.global, ...input.set }, globalRevision: 'saved' }; return structuredClone(settings);
  });
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = (workspacePath?: string) => act(async () => root.render(<ThreadPermissionControl workspacePath={workspacePath} />));
const option = (mode: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(node => node.textContent === `settings.page.harness.permissions.mode.${mode}`)!;
const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label]')!;
const click = (mode: string) => act(async () => option(mode).click());

it('loads the conversation workspace, changes permission mode, and preserves rules and other settings', async () => {
  await render('/conversation-project');
  expect(trigger().disabled).toBe(false);
  expect(fixture.read).toHaveBeenCalledWith(fixture.host, '/conversation-project');
  expect(option('smart').disabled).toBe(true);
  await click('accept-edits');
  expect(fixture.write).toHaveBeenCalledWith(fixture.host, { cwd: '/conversation-project', scope: 'global', expectedRevision: 'initial',
    set: { harness: { permissions: { mode: 'accept-edits', rules: [{ tool: 'example', decision: 'ask' }] }, shell: 'auto' } }, remove: [] });
  expect(trigger().getAttribute('aria-label')).toContain('mode.accept-edits');
});

it('reflects trusted project constraints and external settings changes, and retries failed saves with current settings', async () => {
  settings.projectTrusted = true; settings.project = { harness: { permissions: { mode: 'normal' } } };
  await render('/conversation-project'); await click('bypass');
  expect(option('bypass').getAttribute('aria-checked')).toBe('true');
  expect(trigger().getAttribute('aria-label')).toContain('mode.normal');
  expect(container.textContent).toContain('settings.common.scope.project');
  settings.project = {}; settings.global = { harness: { permissions: { mode: 'accept-edits' }, shell: 'wsl' } }; settings.globalRevision = 'external';
  await act(async () => { fixture.events.forEach(listener => listener({ type: 'settings-changed', owner: 'agent-settings', scope: 'global', revision: 'external', ids: [] })); });
  expect(trigger().getAttribute('aria-label')).toContain('mode.accept-edits');
  fixture.write.mockRejectedValueOnce(new Error('Settings changed'));
  await click('bypass'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('Settings changed');
  settings.global = { harness: { permissions: { mode: 'accept-edits' }, shell: 'auto', tools: { example: false } } }; settings.globalRevision = 'latest';
  await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
  expect(fixture.write.mock.lastCall?.[1]).toMatchObject({ expectedRevision: 'latest', set: { harness: { permissions: { mode: 'bypass' }, tools: { example: false }, shell: 'auto' } } });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('keeps late saves with the original Host and refreshes the new Host without borrowing a navigation workspace', async () => {
  await render('/conversation-project');
  const original = fixture.host;
  let finish!: (value: AgentSettingsSnapshot) => void;
  fixture.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click('bypass');
  settings.global = { harness: { permissions: { mode: 'accept-edits' } } };
  await act(async () => { fixture.host += 1; fixture.endpoints.forEach(listener => listener()); });
  await render();
  await act(async () => finish({ ...settings, global: { harness: { permissions: { mode: 'bypass' } } } }));
  expect(fixture.write.mock.calls.map(([host]) => host)).toEqual([original]);
  expect(fixture.read.mock.lastCall).toEqual([fixture.host, undefined]);
  expect(trigger().getAttribute('aria-label')).toContain('mode.accept-edits');
});
