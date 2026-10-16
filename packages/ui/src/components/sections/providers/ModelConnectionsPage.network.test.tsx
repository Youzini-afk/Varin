import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ModelChannel, ModelConnectionsSnapshot } from '@varin/application-client';
import { ModelConnectionsPage } from './ModelConnectionsPage';

const fixtures = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>(), blockers: new Set<() => Promise<void>>(), api: { read: vi.fn(), save: vi.fn(), cancelAuthorization: vi.fn(), storeCredential: vi.fn(), discoverDraft: vi.fn(), test: vi.fn(), signIn: vi.fn(), authorization: vi.fn() } }));
vi.mock('@varin/application-client', async importOriginal => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  registerRuntimeEndpointSwitchBlocker: (listener: () => Promise<void>) => { fixtures.blockers.add(listener); return () => fixtures.blockers.delete(listener); },
  createModelConnectionsHttpAPI: () => ({ ...fixtures.api }),
  getRuntimeEndpointGeneration: () => fixtures.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixtures.listeners.add(listener); return () => fixtures.listeners.delete(listener); },
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/settings/drafts', () => ({ requestSettingsNavigation: (proceed: () => void) => proceed(), notifySettingsDraftChanged() {} }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('../shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children, headerEnd, titleLeading }: React.PropsWithChildren<{ headerEnd?: React.ReactNode; titleLeading?: React.ReactNode }>) => <div>{titleLeading}{headerEnd}{children}</div> }));
vi.mock('../shared/SettingsSection', () => ({ SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section>, SettingsFieldRow: ({ label, children }: React.PropsWithChildren<{ label: string }>) => <label>{label}{children}</label>, SettingsStackedField: ({ label, children }: React.PropsWithChildren<{ label: string }>) => <label>{label}{children}</label> }));
vi.mock('../shared/AuthorizationPanel', () => ({ AuthorizationPanel: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, disabled, onClick, ...props }: React.ComponentProps<'button'>) => <button {...props} disabled={disabled} onClick={onClick}>{children}</button> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.ComponentProps<'input'>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.ComponentProps<'textarea'>) => <textarea {...props} data-rendered-value={String(props.value ?? "")} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
vi.mock('@/components/ui/switch', () => ({ Switch: ({ checked, disabled, onCheckedChange, ...props }: { checked: boolean; disabled?: boolean; onCheckedChange(value: boolean): void }) => <button {...props} role="switch" aria-checked={checked} disabled={disabled} onClick={() => onCheckedChange(!checked)} /> }));
vi.mock('@/components/ui/checkbox', () => ({ Checkbox: ({ checked, disabled, onChange, ariaLabel }: { checked: boolean; disabled?: boolean; onChange(value: boolean): void; ariaLabel?: string }) => <button role="checkbox" aria-label={ariaLabel} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} /> }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, disabled, onValueChange, children }: React.PropsWithChildren<{ value: string; disabled?: boolean; onValueChange(value: string): void }>) => <select data-value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SelectItem: ({ value, children }: React.PropsWithChildren<{ value: string }>) => <option value={value}>{children}</option>,
}));

let root: Root; let container: HTMLDivElement; let snapshot: ModelConnectionsSnapshot;
beforeEach(() => {
  fixtures.generation = 1; fixtures.listeners.clear(); fixtures.blockers.clear(); vi.resetAllMocks();
  fixtures.api.cancelAuthorization.mockResolvedValue(undefined); fixtures.api.storeCredential.mockResolvedValue({ reference: 'stored' }); fixtures.api.discoverDraft.mockResolvedValue({ models: [{ id: 'discovered', name: 'Discovered', operations: ['embedding'] }] });
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  window.confirm = vi.fn(() => true);
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element); vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('getComputedStyle', () => ({ animationName: 'none', transitionProperty: 'none', getPropertyValue: () => '' }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  snapshot = { revision: 'original', channels: [{ id: 'channel', name: 'Connection', enabled: true, type: 'local', baseUrl: 'http://localhost/v1', authentication: { kind: 'none' }, parameters: {}, models: [],
    connection: { headers: { 'X-Request-Source': 'original' }, paths: { embedding: '/vectors' }, proxy: { mode: 'proxy', url: 'http://localhost:8080' } } }],
    types: [{ id: 'local', name: 'Local', protocol: 'openai-completions', authentication: ['none'], operations: ['chat', 'embedding'], discovery: false, parametersSchema: {} }] };
  fixtures.api.read.mockImplementation(async () => structuredClone(snapshot));
  fixtures.api.save.mockImplementation(async (channel: ModelChannel) => { snapshot = { ...snapshot, revision: 'next', channels: [structuredClone(channel)] }; return snapshot; });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (text: string) => [...container.querySelectorAll('button')].find(button => (button.textContent === text || button.getAttribute('aria-label') === text))!;
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
  await click('settings.models.back');
  expect(container.querySelector(`[aria-label="${embeddingLabel}"]`)).toBeNull();
  await click('Connection');
  expect(button('settings.models.save').disabled).toBe(true);
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
  await edit(label('organizationId'), 'discarded'); await click('settings.models.back'); await click('Connection');
  expect((container.querySelector(`[aria-label="${label('organizationId')}"]`) as HTMLInputElement).value).toBe('org-new');
  await act(async () => { fixtures.generation += 1; fixtures.listeners.forEach(listener => listener()); });
  expect(container.querySelector(`[aria-label="${label('identityTokenFile')}"]`)).toBeNull();
  expect(fixtures.api.save).toHaveBeenCalledTimes(2);
});


test('changing authentication discards an entered key instead of overriding the selected source on save', async () => {
  snapshot.types[0]!.authentication = ['credential', 'environment', 'none'];
  snapshot.channels[0]!.authentication = { kind: 'credential', reference: 'original' };
  await open();
  await edit('settings.models.apiKey', 'unsaved-key');
  await select('credential', 'environment');
  await edit('settings.models.environment', 'MODEL_KEY');
  await click('settings.models.save');
  expect(fixtures.api.storeCredential).not.toHaveBeenCalled();
  expect(fixtures.api.save.mock.calls[0]?.[0].authentication).toEqual({ kind: 'environment', variable: 'MODEL_KEY' });
  await select('environment', 'credential');
  expect((container.querySelector('[aria-label="settings.models.apiKey"]') as HTMLInputElement).value).toBe('');
});

test('new services select a provider before editing connection details', async () => {
  const preset = { id: 'ready', name: 'Ready model', enabled: true, operations: ['chat' as const], input: ['text' as const, 'image' as const], contextWindow: 128000, maxOutputTokens: 8192, reasoning: true, thinking: { mode: 'levels' as const, levels: ['low' as const, 'high' as const], allowOff: true } };
  snapshot.types.push({ ...snapshot.types[0]!, id: 'replacement', name: 'Replacement', defaultBaseUrl: 'https://example.test/v1', catalog: [preset], defaultModelIds: ['ready'] });
  await act(async () => root.render(<ModelConnectionsPage />));
  await click('settings.models.addChannel');
  const provider = [...container.querySelectorAll('button')].find(item => item.textContent?.includes('Replacement'))!;
  await act(async () => provider.click());
  expect((container.querySelector('[aria-label="settings.models.endpoint"]') as HTMLInputElement).value).toBe('https://example.test/v1');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[0]?.[0]).toMatchObject({ type: 'replacement', name: 'Replacement', authentication: { kind: 'none' }, models: [preset] });
});

test('discovery uses unsaved connection and key; model selection only changes the draft', async () => {
  snapshot.types[0]!.discovery = true;
  snapshot.types[0]!.authentication = ['credential'];
  snapshot.channels[0]!.authentication = { kind: 'credential', reference: '' };
  await open(); await edit('settings.models.endpoint', 'http://localhost/new'); await edit('settings.models.apiKey', 'draft-test-key');
  expect(button('settings.models.discover').disabled).toBe(false);
  await click('settings.models.discover');
  expect(fixtures.api.discoverDraft).toHaveBeenCalledWith({ channel: expect.objectContaining({ baseUrl: 'http://localhost/new' }), secret: 'draft-test-key' });
  expect(fixtures.api.save).not.toHaveBeenCalled(); expect(fixtures.api.storeCredential).not.toHaveBeenCalled();
  await click('Discovered'); await click('settings.models.addSelected · 1');
  expect(fixtures.api.save).not.toHaveBeenCalled();
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[0]?.[0].models).toEqual([{ id: 'discovered', name: 'Discovered', enabled: true, operations: ['embedding'] }]);
});

test('contributed catalog candidates are available without discovery and retain declared capabilities', async () => {
  const candidate = { id: 'catalog', name: 'Catalog', enabled: true, operations: ['chat'] as const, contextWindow: 32000, maxOutputTokens: 2000, input: ['text', 'image'] as const };
  snapshot.types[0]!.catalog = [{ ...candidate, operations: [...candidate.operations], input: [...candidate.input] }];
  await open(); await click('settings.models.addModel'); await click('Catalog'); await click('settings.models.addSelected · 1');
  expect(fixtures.api.save).not.toHaveBeenCalled(); expect(fixtures.api.discoverDraft).not.toHaveBeenCalled();
  await click('settings.models.save'); expect(fixtures.api.save.mock.calls[0]?.[0].models).toEqual([candidate]);
});

test('a late save failure from the previous Host cannot poison the new editor', async () => {
  let reject!: (reason: Error) => void;
  fixtures.api.save.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await open(); await edit(embeddingLabel, '/pending'); await click('settings.models.save');
  await act(async () => { fixtures.generation += 1; fixtures.listeners.forEach(listener => listener()); });
  await click('Connection');
  await act(async () => reject(new Error('old-host-error')));
  expect(container.textContent).not.toContain('old-host-error');
  expect(button('settings.models.save').disabled).toBe(true);
});

test('Host switching waits for an in-flight sign-in handle and cancels it on the original owner', async () => {
  snapshot.channels[0]!.authentication = { kind: 'credential', reference: 'original' };
  snapshot.types[0]!.authentication = ['credential']; snapshot.types[0]!.oauthProviders = [{ id: 'oauth', name: 'OAuth' }];
  let resolve!: (state: { id: string; status: 'pending' }) => void;
  fixtures.api.signIn.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  fixtures.api.authorization.mockResolvedValue({ id: 'flow', status: 'pending' });
  await open(); await click('settings.mcp.signIn · OAuth');
  let completed = false;
  const switching = Promise.all([...fixtures.blockers].map(blocker => blocker())).then(() => { completed = true; });
  await act(async () => { await Promise.resolve(); }); expect(completed).toBe(false);
  await act(async () => { resolve({ id: 'flow', status: 'pending' }); await switching; });
  expect(fixtures.api.cancelAuthorization).toHaveBeenCalledWith('flow'); expect(completed).toBe(true);
});

test('unmounting during sign-in cancels the handle when it arrives', async () => {
  snapshot.channels[0]!.authentication = { kind: 'credential', reference: 'original' };
  snapshot.types[0]!.authentication = ['credential']; snapshot.types[0]!.oauthProviders = [{ id: 'oauth', name: 'OAuth' }];
  let resolve!: (state: { id: string; status: 'pending' }) => void;
  fixtures.api.signIn.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await open(); await click('settings.mcp.signIn · OAuth');
  await act(async () => root.render(null));
  await act(async () => resolve({ id: 'late-flow', status: 'pending' }));
  expect(fixtures.api.cancelAuthorization).toHaveBeenCalledWith('late-flow'); expect(fixtures.api.authorization).not.toHaveBeenCalled();
});


test('changing the discovery connection retires its old candidates even after the new connection is saved', async () => {
  snapshot.types[0]!.discovery = true;
  await open(); await click('settings.models.discover');
  expect(button('Discovered')).toBeDefined();
  await edit('settings.models.endpoint', 'http://localhost/replacement');
  expect(button('Discovered')).toBeUndefined();
  await click('settings.models.save');
  expect(button('Discovered')).toBeUndefined();
  expect(fixtures.api.discoverDraft).toHaveBeenCalledOnce();
});


test('service tab changes retain draft edits; a failed save stays dirty and Cancel restores persisted configuration', async () => {
  await open();
  await edit('settings.models.endpoint', 'http://localhost/unsaved');
  await click('settings.models.advanced');
  await edit(embeddingLabel, '/unsaved-path');
  await click('settings.models.connectionModels');
  expect((container.querySelector('[aria-label="settings.models.endpoint"]') as HTMLInputElement).value).toBe('http://localhost/unsaved');
  fixtures.api.save.mockRejectedValueOnce(new Error('Revision conflict'));
  await click('settings.models.save');
  expect(container.textContent).toContain('Revision conflict');
  expect(button('settings.models.save').disabled).toBe(false);
  await click('settings.common.actions.cancel');
  expect((container.querySelector('[aria-label="settings.models.endpoint"]') as HTMLInputElement).value).toBe('http://localhost/v1');
  expect((container.querySelector(`[aria-label="${embeddingLabel}"]`) as HTMLInputElement).value).toBe('/vectors');
  expect(button('settings.models.save').disabled).toBe(true);
  expect(fixtures.api.discoverDraft).not.toHaveBeenCalled();
});

test('model capabilities save declared effort choices, image input and capacities', async () => {
  snapshot.channels[0]!.models = [{ id: 'model', name: 'Model', operations: ['chat'], enabled: true }];
  await open(); await click('Model');
  await click('settings.models.reasoning');
  expect(button('settings.models.save').disabled).toBe(true);
  await click('settings.agents.thinking.low'); await click('settings.agents.thinking.high');
  await click('settings.models.imageInput'); await edit('settings.models.context', '128000'); await edit('settings.models.output', '8192');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[0]?.[0].models[0]).toMatchObject({ reasoning: true, input: ['text', 'image'],
    thinking: { mode: 'levels', levels: ['low', 'high'], allowOff: true }, contextWindow: 128000, maxOutputTokens: 8192 });
});
