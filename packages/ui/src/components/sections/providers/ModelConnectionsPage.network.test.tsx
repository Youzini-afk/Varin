import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ModelChannel, ModelConnectionsSnapshot } from '@varin/application-client';
import { ModelConnectionsPage } from './ModelConnectionsPage';

const fixtures = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>(), blockers: new Set<() => Promise<void>>(), api: { read: vi.fn(), directory: vi.fn(), save: vi.fn(), cancelAuthorization: vi.fn(), storeCredential: vi.fn(), discoverDraft: vi.fn(), test: vi.fn(), signIn: vi.fn(), authorization: vi.fn() } }));
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
  fixtures.api.read.mockImplementation(async () => ({ ...structuredClone(snapshot), types: snapshot.types.map(({ catalog: _catalog, ...type }) => structuredClone(type)) }));
  fixtures.api.directory.mockImplementation(async (type: string) => ({ models: structuredClone(snapshot.types.find(value => value.id === type)?.catalog ?? []), status: { revision: 'directory', refreshing: false } }));
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
const configureOpenedModel = async () => {
  const configure = [...container.querySelectorAll('button')].find(button => button.textContent === 'settings.models.advanced' && button.getAttribute('role') !== 'tab' && !button.closest('[hidden]'))!;
  await act(async () => configure.click());
};
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
  await click('settings.models.save'); expect(fixtures.api.save.mock.calls[0]?.[0].models).toEqual([{ ...candidate, catalog: { overrides: [], match: { requestModelId: 'catalog' } } }]);
});

test('manual model metadata fills asynchronously, preserves edits made while loading, and follows a changed upstream ID', async () => {
  let complete!: (value: unknown) => void;
  fixtures.api.directory.mockImplementation(async (_type, _signal, _channel, requests = []) => {
    if (!requests.length) return { models: [], status: { revision: 'directory', refreshing: false } };
    const request = requests[0];
    if (!request.requestModelId) return new Promise(resolve => { complete = resolve; });
    return { models: [{ ...request, name: request.id, enabled: false, contextWindow: 200000, maxOutputTokens: 8000, reasoning: false, catalog: { overrides: [] } }], status: { revision: 'directory', refreshing: false } };
  });
  await open(); await click('settings.models.addModel');
  await edit('settings.models.modelId', 'team/DEEPSEEK-FLASH-fast');
  const add = container.querySelector('[aria-label="settings.models.modelId"]')!.parentElement!.querySelector('button')!;
  await act(async () => add.click());
  await click('team/DEEPSEEK-FLASH-fast');
  await edit('settings.models.context', '123456');
  await act(async () => complete({ models: [{ id: 'team/DEEPSEEK-FLASH-fast', name: 'Matched', enabled: false, operations: ['chat'],
    contextWindow: 1000000, maxOutputTokens: 32000, reasoning: true, thinking: { mode: 'levels', levels: ['low', 'high'], allowOff: true }, catalog: { overrides: [] } }], status: { revision: 'directory', refreshing: false } }));
  expect((container.querySelector('[aria-label="settings.models.context"]') as HTMLInputElement).value).toBe('123456');
  expect((container.querySelector('[aria-label="settings.models.output"]') as HTMLInputElement).value).toBe('32000');
  await configureOpenedModel();
  await edit('settings.models.requestModelId', 'new/GPT-4.1-mini');
  await click('settings.models.save');
  const saved = fixtures.api.save.mock.calls[0]![0].models[0];
  expect(saved).toMatchObject({ id: 'team/DEEPSEEK-FLASH-fast', name: 'team/DEEPSEEK-FLASH-fast', requestModelId: 'new/GPT-4.1-mini',
    contextWindow: 123456, maxOutputTokens: 8000, reasoning: false });
  expect(saved.catalog.overrides).toContain('contextWindow');
  expect(saved.thinking).toBeUndefined();
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
  await click('settings.experience.connection');
  await edit('settings.models.endpoint', 'http://localhost/unsaved');
  await click('settings.experience.requests');
  await edit(embeddingLabel, '/unsaved-path');
  await click('settings.experience.connection');
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

test.each([undefined, 'cloudflare-workers-ai-system-one'])('decision API belongs to the decision model, inheriting %s without rewriting its service or sibling', async inherited => {
  snapshot.types[0]!.operations.push('decision');
  snapshot.types[0]!.parametersSchema = { properties: { decisionApi: { enum: ['typesafe-system-one', 'cloudflare-workers-ai-system-one'] } } };
  snapshot.types[0]!.defaultParameters = { decisionApi: 'typesafe-system-one' };
  const parameters: ModelChannel['parameters'] = inherited ? { decisionApi: inherited } : {};
  snapshot.channels[0]!.parameters = parameters;
  snapshot.channels[0]!.connection!.paths!.decision = '/service-decision';
  const other: ModelChannel['models'][number] = { id: 'other', name: 'Other', enabled: true, operations: ['decision'] };
  snapshot.channels[0]!.models = [{ id: 'jev-latest', name: 'Jev', enabled: true, operations: ['chat'], catalog: { overrides: [] } }, other];
  await open();
  expect(container.querySelector('option[value="typesafe-system-one"]')).toBeNull();
  await click('Jev');
  await configureOpenedModel();
  expect(container.querySelector('option[value="typesafe-system-one"]')).toBeNull();
  await click('settings.models.operation.decision');
  await click('settings.models.operation.chat');
  const originalApi = inherited ?? 'typesafe-system-one';
  const api = inherited ? 'typesafe-system-one' : 'cloudflare-workers-ai-system-one';
  const decisionPath = () => (container.querySelector('[aria-label="settings.models.decisionPath"]') as HTMLInputElement).value;
  expect(container.querySelector(`select[data-value="${originalApi}"]`)).not.toBeNull();
  expect(decisionPath()).toBe('/service-decision');
  await select(originalApi, api);
  expect(decisionPath()).toBe(inherited ? '/systemone' : '/run');
  await edit('settings.models.decisionPath', '/custom/decide');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[0]?.[0]).toMatchObject({ parameters,
    connection: { paths: { decision: '/service-decision' } },
    models: [{ id: 'jev-latest', operations: ['decision'], decision: { api, paths: { classify: '/custom/decide' } }, catalog: { overrides: ['operations', 'decision'] } }, other] });
  expect(decisionPath()).toBe('/custom/decide');
  await click('settings.models.operation.chat'); await click('settings.models.operation.decision');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[1]?.[0].models[0]).toMatchObject({ operations: ['chat'] });
  expect(fixtures.api.save.mock.calls[1]?.[0].models[0].decision).toBeUndefined();
});

test.each(['embedding', 'rerank', 'decision'] as const)('%s context capacity can be edited in the model row and detail page', async operation => {
  snapshot.types[0]!.operations = ['chat', operation];
  snapshot.channels[0]!.models = [{ id: 'model', name: 'Model', operations: [operation], enabled: true }];
  await open(); await click('Model');
  expect(container.querySelector('[aria-label="settings.models.reasoning"]')).toBeNull();
  await edit('settings.models.context', '32768');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[0]?.[0].models[0]).toMatchObject({ operations: [operation], contextWindow: 32768 });
  await configureOpenedModel();
  const context = [...container.querySelectorAll<HTMLInputElement>('[aria-label="settings.models.context"]')].find(input => !input.closest('[hidden]'))!;
  expect(context.value).toBe('32768');
  await act(async () => { context.value = '65536'; context.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[1]?.[0].models[0]).toMatchObject({ operations: [operation], contextWindow: 65536 });
});

test('image presets fill editable generation and editing paths while preserving the service and sibling', async () => {
  snapshot.types[0]!.operations = ['chat', 'image-generation', 'image-editing'];
  snapshot.types[0]!.parametersSchema = { properties: { imageApi: { enum: ['openai-images', 'openrouter-images'] } } };
  snapshot.channels[0]!.parameters = { imageApi: 'openai-images' };
  snapshot.channels[0]!.connection!.paths!['image-generation'] = '/service-generate';
  snapshot.channels[0]!.connection!.paths!['image-editing'] = '/service-edit';
  const other: ModelChannel['models'][number] = { id: 'other', name: 'Other', enabled: true, operations: ['image-generation'] };
  snapshot.channels[0]!.models = [{ id: 'image', name: 'Image', enabled: true, operations: ['image-generation', 'image-editing'], image: { mask: false } }, other];
  await open();
  expect(container.querySelector('[aria-label="settings.models.parameter.imageApi"]')).toBeNull();
  await click('Image'); await configureOpenedModel();
  expect(container.querySelector('select[data-value="openai-images"]')).not.toBeNull();
  const path = (name: string) => (container.querySelector(`[aria-label="settings.models.${name}Path"]`) as HTMLInputElement).value;
  expect(path('imageGeneration')).toBe('/service-generate');
  expect(path('imageEditing')).toBe('/service-edit');
  await select('openai-images', 'openrouter-images');
  expect(path('imageGeneration')).toBe('/chat/completions');
  expect(path('imageEditing')).toBe('/chat/completions');
  await edit('settings.models.imageGenerationPath', '/custom/generate');
  await edit('settings.models.imageEditingPath', '/custom/edit');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[0]?.[0]).toMatchObject({ parameters: { imageApi: 'openai-images' },
    connection: { paths: { 'image-generation': '/service-generate', 'image-editing': '/service-edit' } },
    models: [{ id: 'image', image: { api: 'openrouter-images', mask: false, paths: { generation: '/custom/generate', editing: '/custom/edit' } } }, other] });
  await select('openrouter-images', 'openai-images');
  expect(path('imageGeneration')).toBe('/images/generations');
  expect(path('imageEditing')).toBe('/images/edits');
  await edit('settings.models.imageGenerationPath', '');
  const field = container.querySelector('[aria-label="settings.models.imageGenerationPath"]')!;
  await act(async () => { field.dispatchEvent(new window.Event('focusout', { bubbles: true })); });
  expect(path('imageGeneration')).toBe('/service-generate');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[1]?.[0].models[0].image.paths).toEqual({ editing: '/images/edits' });
  await click('settings.models.operation.chat');
  await click('settings.models.operation.image-generation'); await click('settings.models.operation.image-editing');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[2]?.[0].models[0]).toMatchObject({ operations: ['chat'] });
  expect(fixtures.api.save.mock.calls[2]?.[0].models[0].image).toBeUndefined();
});

test('llama.cpp exposes three editable request paths and switching presets fills the new protocol path', async () => {
  snapshot.types[0]!.operations.push('decision');
  snapshot.types[0]!.defaultParameters = { decisionApi: 'typesafe-system-one' };
  snapshot.channels[0]!.models = [{ id: 'model', name: 'Model', enabled: true, operations: ['decision'] }];
  await open(); await click('Model'); await configureOpenedModel();
  await select('typesafe-system-one', 'llama-cpp-classify');
  for (const [key, path] of [['tokenize', '/tokenize'], ['applyTemplate', '/apply-template'], ['completion', '/completion']]) {
    expect((container.querySelector(`[aria-label="settings.models.${key}Path"]`) as HTMLInputElement).value).toBe(path);
    await edit(`settings.models.${key}Path`, `/custom${path}`);
  }
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[0]?.[0].models[0].decision).toEqual({ api: 'llama-cpp-classify',
    paths: { tokenize: '/custom/tokenize', applyTemplate: '/custom/apply-template', completion: '/custom/completion' } });
  await select('llama-cpp-classify', 'typesafe-system-one');
  expect(container.querySelector('[aria-label="settings.models.tokenizePath"]')).toBeNull();
  expect((container.querySelector('[aria-label="settings.models.decisionPath"]') as HTMLInputElement).value).toBe('/systemone');
  await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[1]?.[0].models[0].decision).toEqual({ api: 'typesafe-system-one', paths: { classify: '/systemone' } });
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
