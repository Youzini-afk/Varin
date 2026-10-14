import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ModelChannel, ModelConnectionsSnapshot } from '@varin/application-client';
import { ModelConnectionsPage } from './ModelConnectionsPage';

const fixtures = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>(), api: { read: vi.fn(), save: vi.fn(), cancelAuthorization: vi.fn() } }));
vi.mock('@varin/application-client', () => ({
  createModelConnectionsHttpAPI: () => ({ ...fixtures.api }),
  getRuntimeEndpointGeneration: () => fixtures.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixtures.listeners.add(listener); return () => fixtures.listeners.delete(listener); },
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('../shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('../shared/SettingsSection', () => ({ SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section>, SettingsFieldRow: ({ label, children }: React.PropsWithChildren<{ label: string }>) => <label>{label}{children}</label> }));
vi.mock('../shared/AuthorizationPanel', () => ({ AuthorizationPanel: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, disabled, onClick }: React.ComponentProps<'button'>) => <button disabled={disabled} onClick={onClick}>{children}</button> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.ComponentProps<'input'>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.ComponentProps<'textarea'>) => <textarea {...props} data-rendered-value={String(props.value ?? "")} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
vi.mock('@/components/ui/checkbox', () => ({ Checkbox: () => <span /> }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, disabled, onValueChange, children }: React.PropsWithChildren<{ value: string; disabled?: boolean; onValueChange(value: string): void }>) => <select data-value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SelectItem: ({ value, children }: React.PropsWithChildren<{ value: string }>) => <option value={value}>{children}</option>,
}));

let root: Root; let container: HTMLDivElement; let snapshot: ModelConnectionsSnapshot;
beforeEach(() => {
  fixtures.generation = 1; fixtures.listeners.clear(); vi.clearAllMocks();
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  snapshot = { revision: 'original', channels: [{ id: 'channel', name: 'Connection', enabled: true, type: 'local', baseUrl: 'http://localhost/v1', authentication: { kind: 'none' }, parameters: {}, models: [],
    connection: { headers: { 'X-Request-Source': 'original' }, paths: { embedding: '/vectors' }, proxy: { mode: 'proxy', url: 'http://localhost:8080' } } }],
    types: [{ id: 'local', name: 'Local', protocol: 'openai-completions', authentication: ['none'], operations: ['chat', 'embedding'], discovery: false, parametersSchema: {} }] };
  fixtures.api.read.mockImplementation(async () => structuredClone(snapshot));
  fixtures.api.save.mockImplementation(async (channel: ModelChannel) => { snapshot = { ...snapshot, revision: 'next', channels: [structuredClone(channel)] }; return snapshot; });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
const edit = async (label: string, value: string) => {
  const element = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => { element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true })); });
};
const select = async (current: string, next: string) => {
  const element = container.querySelector(`select[data-value="${current}"]`)!;
  await act(async () => { Object.defineProperty(element, 'value', { configurable: true, value: next }); element.dispatchEvent(new window.Event('change', { bubbles: true })); });
};
const open = async () => { await act(async () => root.render(<ModelConnectionsPage />)); await click('Connection'); };
const embeddingLabel = 'settings.models.path: settings.models.operation.embedding';

test('network controls load saved values, save typed changes, and clear options back to Host defaults', async () => {
  await open();
  expect((container.querySelector(`[aria-label="${embeddingLabel}"]`) as HTMLInputElement).value).toBe('/vectors');
  await edit(embeddingLabel, '/vectors-new');
  await edit('settings.models.headers', '{"X-Request-Source":"changed"}');
  await select('proxy', 'direct');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[0]).toEqual([expect.objectContaining({ connection: { headers: { 'X-Request-Source': 'changed' }, paths: { embedding: '/vectors-new' }, proxy: { mode: 'direct' } } }), 'original']);
  await edit(embeddingLabel, ''); await edit('settings.models.headers', ''); await select('direct', 'host');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[1]?.[0].connection).toBeUndefined();
  expect(fixtures.api.save.mock.calls[1]?.[1]).toBe('next');
});

test('invalid headers cannot save, closing discards edits, and a Host change clears the original editor', async () => {
  await open();
  await edit('settings.models.headers', '{"X-Request-Source":42}');
  expect(button('settings.models.save').disabled).toBe(true);
  await click('settings.models.close');
  expect(container.querySelector(`[aria-label="${embeddingLabel}"]`)).toBeNull();
  await click('Connection');
  expect(button('settings.models.save').disabled).toBe(false);
  expect(container.querySelector('[aria-label="settings.models.headers"]')?.getAttribute('data-rendered-value')).toContain('original');
  await edit(embeddingLabel, '/discarded');
  await act(async () => { fixtures.generation += 1; fixtures.listeners.forEach(listener => listener()); });
  expect(container.querySelector(`[aria-label="${embeddingLabel}"]`)).toBeNull();
  expect(fixtures.api.save).not.toHaveBeenCalled();
});

test('workload identity fields save explicit Host configuration and discard interrupted edits', async () => {
  snapshot.channels[0] = { ...snapshot.channels[0]!, type: 'anthropic', authentication: { kind: 'anthropic-federation', identityTokenFile: '/host/identity.jwt', organizationId: 'org-original', federationRuleId: 'rule-original' } };
  snapshot.types = [{ id: 'anthropic', name: 'Anthropic', protocol: 'anthropic-messages', authentication: ['anthropic-federation', 'none'], operations: ['chat'], discovery: false, parametersSchema: {} }];
  await open();
  const label = (field: string) => `settings.models.federation.${field}`;
  expect((container.querySelector(`[aria-label="${label('identityTokenFile')}"]`) as HTMLInputElement).value).toBe('/host/identity.jwt');
  await edit(label('organizationId'), 'org-new'); await edit(label('workspaceId'), 'default');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[0]?.[0].authentication).toEqual({ kind: 'anthropic-federation', identityTokenFile: '/host/identity.jwt', organizationId: 'org-new', federationRuleId: 'rule-original', workspaceId: 'default' });
  await edit(label('workspaceId'), ''); await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[1]?.[0].authentication.workspaceId).toBeUndefined();
  await edit(label('organizationId'), 'discarded'); await click('settings.models.close'); await click('Connection');
  expect((container.querySelector(`[aria-label="${label('organizationId')}"]`) as HTMLInputElement).value).toBe('org-new');
  await act(async () => { fixtures.generation += 1; fixtures.listeners.forEach(listener => listener()); });
  expect(container.querySelector(`[aria-label="${label('identityTokenFile')}"]`)).toBeNull();
  expect(fixtures.api.save).toHaveBeenCalledTimes(2);
});
