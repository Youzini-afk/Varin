import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ModelChannel, ModelConnectionsSnapshot } from '@varin/application-client';
import { ModelConnectionsPage } from './ModelConnectionsPage';

const fixtures = vi.hoisted(() => ({ generation: 1, focus: null as { channelId: string; modelId: string } | null, listeners: new Set<() => void>(), blockers: new Set<() => Promise<void>>(), api: { read: vi.fn(), directory: vi.fn(), save: vi.fn(), cancelAuthorization: vi.fn(), storeCredential: vi.fn(), readSettings: vi.fn(), discoverDraft: vi.fn(), test: vi.fn(), signIn: vi.fn(), authorization: vi.fn() } }));
vi.mock('@varin/application-client', async importOriginal => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  registerRuntimeEndpointSwitchBlocker: (listener: () => Promise<void>) => { fixtures.blockers.add(listener); return () => fixtures.blockers.delete(listener); },
  createModelConnectionsHttpAPI: () => ({ ...fixtures.api }),
  getRuntimeEndpointGeneration: () => fixtures.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixtures.listeners.add(listener); return () => fixtures.listeners.delete(listener); },
}));
vi.mock('@/stores/useUIStore', () => {
  const state = { get settingsModelFocus() { return fixtures.focus; }, setSettingsModelFocus: (focus: typeof fixtures.focus) => { fixtures.focus = focus; }, setSettingsPage: vi.fn() };
  return { useUIStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/settings/drafts', () => ({ requestSettingsNavigation: (proceed: () => void) => proceed(), notifySettingsDraftChanged() {} }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('../shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children, headerEnd, titleLeading }: React.PropsWithChildren<{ headerEnd?: React.ReactNode; titleLeading?: React.ReactNode }>) => <div>{titleLeading}{headerEnd}{children}</div> }));
vi.mock('../shared/SettingsSection', () => ({ SettingsSection: ({ children, title }: React.PropsWithChildren<{ title?: React.ReactNode }>) => <section><h2>{title}</h2>{children}</section>, SettingsFieldRow: ({ label, children }: React.PropsWithChildren<{ label: string }>) => <label>{label}{children}</label>, SettingsStackedField: ({ label, children }: React.PropsWithChildren<{ label: string }>) => <label>{label}{children}</label> }));
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


vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, disabled }: React.ComponentProps<'button'>) => <button disabled={disabled} onClick={onClick}>{children}</button>,
}));
vi.mock('@/components/ui/dialog', () => {
  const Open = React.createContext(false);
  return {
    Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => <Open.Provider value={open}>{children}</Open.Provider>,
    DialogContent: ({ children }: React.PropsWithChildren) => React.useContext(Open) ? <div role="dialog">{children}</div> : null,
    DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  };
});
vi.mock('@base-ui/react/dialog', () => {
  const State = React.createContext({ open: false, onOpenChange: (_value: boolean) => {} });
  return { Dialog: {
    Root: ({ children, open, onOpenChange }: React.PropsWithChildren<{ open: boolean; onOpenChange(value: boolean): void }>) => <State.Provider value={{ open, onOpenChange }}>{children}</State.Provider>,
    Portal: ({ children }: React.PropsWithChildren) => React.useContext(State).open ? <>{children}</> : null,
    Backdrop: () => null,
    Popup: ({ children }: React.PropsWithChildren) => <div role="dialog">{children}</div>,
    Title: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
    Close: ({ children, render }: React.PropsWithChildren<{ render: React.ReactElement<React.ComponentProps<'button'>> }>) => {
      const state = React.useContext(State);
      return React.cloneElement(render, { onClick: () => state.onOpenChange(false) }, children);
    },
  } };
});
let root: Root; let container: HTMLDivElement; let snapshot: ModelConnectionsSnapshot;
beforeEach(() => {
  fixtures.generation = 1; fixtures.focus = null; fixtures.listeners.clear(); fixtures.blockers.clear(); vi.resetAllMocks();
  fixtures.api.readSettings.mockResolvedValue({ global: {}, project: {}, globalRevision: 'g', projectRevision: 'p', projectTrusted: false });
  fixtures.api.test.mockResolvedValue({ requestId: 'tested', modelId: 'model', elapsedMs: 15, text: 'Ready' });
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
  fixtures.api.save.mockImplementation(async (channel: ModelChannel) => { snapshot = { ...snapshot, revision: snapshot.revision + '+', channels: [...snapshot.channels.filter(value => value.id !== channel.id), structuredClone(channel)] }; return snapshot; });
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
const field = (label: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const commit = async (label: string, value: string) => {
  await edit(label, value);
  await act(async () => field(label).dispatchEvent(new window.Event('focusout', { bubbles: true })));
};
const model = (id = 'model', name = 'Model'): ModelChannel['models'][number] => ({ id, name, enabled: true, operations: ['chat'] });
const lastSaved = () => fixtures.api.save.mock.calls.at(-1)![0] as ModelChannel;

test('connection options validate JSON, preserve Host values and clear back to defaults', async () => {
  await open(); await edit(embeddingLabel, '/new'); await edit('settings.models.headers', '{"X":42}'); expect(button('settings.models.save').disabled).toBe(true);
  await edit('settings.models.headers', '{"X":"changed"}'); await select('proxy', 'direct'); await click('settings.models.save');
  expect(fixtures.api.save.mock.calls[0]).toEqual([expect.objectContaining({ connection: { headers: { X: 'changed' }, paths: { embedding: '/new' }, proxy: { mode: 'direct' } } }), 'original']);
  await edit(embeddingLabel, ''); await edit('settings.models.headers', ''); await select('direct', 'host'); await click('settings.models.save'); expect(lastSaved().connection).toBeUndefined(); expect(fixtures.api.save.mock.calls[1]?.[1]).toBe('original+');
});
test('Host changes discard drafts and keys, and fence late save errors', async () => {
  snapshot.types[0]!.authentication = ['credential']; snapshot.channels[0]!.authentication = { kind: 'credential', reference: '' };
  let reject!: (error: Error) => void; fixtures.api.save.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await open(); await edit('settings.models.apiKey', 'temporary'); await edit(embeddingLabel, '/pending'); await click('settings.models.save');
  await act(async () => { fixtures.generation += 1; fixtures.listeners.forEach(listener => listener()); }); await click('Connection'); await act(async () => reject(new Error('old-host-error')));
  expect(container.textContent).not.toContain('old-host-error'); expect(field('settings.models.apiKey').value).toBe(''); expect(field(embeddingLabel).value).toBe('/vectors');
});
test('changing authentication discards an unsaved key', async () => {
  snapshot.types[0]!.authentication = ['credential', 'environment', 'none']; snapshot.channels[0]!.authentication = { kind: 'credential', reference: 'original' };
  await open(); await edit('settings.models.apiKey', 'temporary'); await select('credential', 'environment'); await edit('settings.models.environment', 'MODEL_KEY'); await click('settings.models.save');
  expect(fixtures.api.storeCredential).not.toHaveBeenCalled(); expect(lastSaved().authentication).toEqual({ kind: 'environment', variable: 'MODEL_KEY' }); await select('environment', 'credential'); expect(field('settings.models.apiKey').value).toBe('');
});
test('workload identity saves separately and Cancel restores the connection draft', async () => {
  snapshot.channels[0]!.authentication = { kind: 'anthropic-federation', identityTokenFile: '/identity.jwt', organizationId: 'org', federationRuleId: 'rule' }; snapshot.types[0]!.authentication = ['anthropic-federation'];
  await open(); await edit('settings.models.federation.organizationId', 'changed'); await edit('settings.models.federation.workspaceId', 'workspace'); await click('settings.models.save'); expect(lastSaved().authentication).toMatchObject({ organizationId: 'changed', workspaceId: 'workspace' });
  await edit('settings.models.federation.organizationId', 'discard'); await click('settings.common.actions.cancel'); expect(field('settings.models.federation.organizationId').value).toBe('changed');
});
const suspendedSignIns = ['openai-codex', 'anthropic', 'github-copilot', 'opencode', 'kimi-coding', 'xai', 'meta'];
test.each(suspendedSignIns)('%s keeps existing credentials editable without offering suspended login', async provider => {
  snapshot.channels[0]!.type = provider; snapshot.channels[0]!.authentication = { kind: 'credential', reference: 'saved' }; snapshot.types[0]!.id = provider; snapshot.types[0]!.authentication = ['credential']; snapshot.types[0]!.oauthProviders = [{ id: provider, name: provider }];
  await open(); expect([...container.querySelectorAll('button')].some(button => button.textContent?.startsWith('settings.mcp.signIn'))).toBe(false); expect(field('settings.models.apiKey').placeholder).toBe('settings.models.credentialSaved');
  await edit('settings.models.name', 'Renamed'); await click('settings.models.save'); expect(lastSaved().authentication).toEqual({ kind: 'credential', reference: 'saved' });
});
test('new-service type picker offers only OpenRouter account login', async () => {
  const template = snapshot.types[0]!; snapshot.types = [...suspendedSignIns, 'openrouter'].map(id => ({ ...template, id, name: id, authentication: ['credential'], oauthProviders: [{ id, name: id }] }));
  await act(async () => root.render(<ModelConnectionsPage />)); await click('settings.models.addChannel');
  const offers = [...container.querySelectorAll('button')].filter(button => button.textContent?.includes('settings.models.accountSignIn')); expect(offers).toHaveLength(1); expect(offers[0]!.textContent).toContain('openrouter'); await act(async () => offers[0]!.click());
  fixtures.api.signIn.mockResolvedValue({ id: 'flow', status: 'pending' }); fixtures.api.authorization.mockResolvedValue({ id: 'flow', status: 'pending' }); await click('settings.mcp.signIn · openrouter'); expect(fixtures.api.signIn).toHaveBeenCalledWith('openrouter', expect.stringMatching(/^model:/));
});
test.each(['switch', 'unmount'])('%s cancels the original pending authorization when its handle arrives', async action => {
  snapshot.types[0]!.authentication = ['credential']; snapshot.types[0]!.oauthProviders = [{ id: 'openrouter', name: 'OpenRouter' }]; snapshot.channels[0]!.authentication = { kind: 'credential', reference: 'saved' };
  let resolve!: (value: { id: string; status: 'pending' }) => void; fixtures.api.signIn.mockImplementationOnce(() => new Promise(done => { resolve = done; })); fixtures.api.authorization.mockResolvedValue({ id: 'flow', status: 'pending' });
  await open(); await click('settings.mcp.signIn · OpenRouter');
  let done = false; const pending = action === 'switch' ? Promise.all([...fixtures.blockers].map(blocker => blocker())).then(() => { done = true; }) : Promise.resolve();
  if (action === 'unmount') await act(async () => root.render(null)); else { await act(async () => { await Promise.resolve(); }); expect(done).toBe(false); }
  await act(async () => { resolve({ id: 'flow', status: 'pending' }); await pending; }); expect(fixtures.api.cancelAuthorization).toHaveBeenCalledWith('flow');
  if (action === 'unmount') expect(fixtures.api.authorization).not.toHaveBeenCalled();
});
test('three-step creation stores credentials only when confirming selected models', async () => {
  snapshot.types[0] = { ...snapshot.types[0]!, defaultBaseUrl: 'https://example.test/v1', authentication: ['credential'], catalog: [{ ...model('ready', 'Ready'), contextWindow: 128000 }], defaultModelIds: ['ready'], discovery: true };
  await act(async () => root.render(<ModelConnectionsPage />)); await click('settings.models.addChannel'); await click('Localexample.test/v1'); expect(field('settings.models.endpoint').value).toBe('https://example.test/v1');
  await edit('settings.models.apiKey', 'key'); await click('settings.models.connectAndDiscover'); expect(fixtures.api.storeCredential).not.toHaveBeenCalled(); expect(fixtures.api.save).not.toHaveBeenCalled();
  expect(button('Ready').getAttribute('aria-checked')).toBe('true'); await click('Discovered'); await click('settings.models.addChannel · 2'); expect(fixtures.api.storeCredential).toHaveBeenCalledOnce(); expect(fixtures.api.save).toHaveBeenCalledOnce();
  expect(lastSaved()).toMatchObject({ authentication: { kind: 'credential', reference: 'stored' }, models: expect.arrayContaining([expect.objectContaining({ id: 'ready', contextWindow: 128000 }), expect.objectContaining({ id: 'discovered' })]) });
});
test('non-discovery service creation allows manual IDs and catalog without testing', async () => {
  await act(async () => root.render(<ModelConnectionsPage />)); await click('settings.models.addChannel'); await click('Localsettings.models.customEndpoint'); await click('settings.models.chooseModels'); await edit('settings.models.modelId', 'manual');
  await act(async () => field('settings.models.modelId').parentElement!.querySelector('button')!.click()); await click('settings.models.addChannel · 1'); expect(fixtures.api.discoverDraft).not.toHaveBeenCalled(); expect(fixtures.api.test).not.toHaveBeenCalled(); expect(lastSaved().models[0]).toMatchObject({ id: 'manual', operations: ['chat'] });
});
test('testing uses connection drafts without saving; edited connections retire discovery results', async () => {
  snapshot.types[0]!.discovery = true; snapshot.types[0]!.authentication = ['credential']; snapshot.channels[0]!.authentication = { kind: 'credential', reference: '' };
  await open(); await edit('settings.models.endpoint', 'http://localhost/new'); await edit('settings.models.apiKey', 'draft-key'); await click('settings.models.testConnection');
  expect(fixtures.api.discoverDraft).toHaveBeenCalledWith({ channel: expect.objectContaining({ baseUrl: 'http://localhost/new' }), secret: 'draft-key' }, expect.any(AbortSignal)); expect(fixtures.api.save).not.toHaveBeenCalled(); expect(fixtures.api.storeCredential).not.toHaveBeenCalled();
  await edit('settings.models.endpoint', 'http://localhost/changed'); await click('settings.models.addModel'); expect(button('Discovered')).toBeUndefined();
});
test('non-discovery connection tests use the first enabled model', async () => {
  snapshot.channels[0]!.models = [{ ...model('disabled'), enabled: false }, model('enabled')]; await open(); await edit('settings.models.endpoint', 'http://localhost/draft'); await click('settings.models.testConnection');
  expect(fixtures.api.test).toHaveBeenCalledWith(expect.objectContaining({ channel: expect.objectContaining({ baseUrl: 'http://localhost/draft' }), modelId: 'enabled' }), expect.any(AbortSignal)); expect(fixtures.api.save).not.toHaveBeenCalled();
});
test('model additions save immediately while leaving connection drafts untouched', async () => {
  snapshot.types[0]!.catalog = [{ ...model('catalog', 'Catalog'), contextWindow: 32000 }]; await open(); await edit('settings.models.endpoint', 'http://localhost/unsaved'); await click('settings.models.addModel'); await click('Catalog'); await click('settings.models.addSelected · 1');
  expect(lastSaved().baseUrl).toBe('http://localhost/v1'); expect(lastSaved().models[0]).toMatchObject({ id: 'catalog', contextWindow: 32000 }); expect(field('settings.models.endpoint').value).toBe('http://localhost/unsaved'); await click('settings.models.save'); expect(lastSaved().baseUrl).toBe('http://localhost/unsaved'); expect(lastSaved().models).toHaveLength(1);
});
test('concurrent model changes queue against latest revisions and survive a connection save', async () => {
  snapshot.channels[0]!.models = [model()]; const save = fixtures.api.save.getMockImplementation()!; let release!: () => void;
  fixtures.api.save.mockImplementationOnce(async (...args: unknown[]) => { await new Promise<void>(resolve => { release = resolve; }); return save(...args); });
  await open(); await click('Model'); await commit('settings.models.modelDescription', 'My description'); await commit('settings.models.context', '65536'); await commit('settings.models.output', '8192'); expect(fixtures.api.save).toHaveBeenCalledTimes(1);
  await act(async () => release()); expect(fixtures.api.save.mock.calls.map(call => call[1])).toEqual(['original', 'original+', 'original++']); expect(lastSaved().models[0]).toMatchObject({ description: 'My description', contextWindow: 65536, maxOutputTokens: 8192 });
  await click('settings.models.close'); await edit('settings.models.endpoint', 'http://localhost/connection'); await click('settings.models.save'); expect(lastSaved().models[0]).toMatchObject({ description: 'My description', contextWindow: 65536 });
});
test('failed model saves reload persisted models without erasing connection drafts', async () => {
  snapshot.channels[0]!.models = [model()]; await open(); await edit('settings.models.endpoint', 'http://localhost/draft'); await click('Model'); fixtures.api.save.mockRejectedValueOnce(new Error('Revision conflict')); await commit('settings.models.context', '12345');
  expect(container.textContent).toContain('Revision conflict'); expect(field('settings.models.context').value).toBe(''); expect(field('settings.models.endpoint').value).toBe('http://localhost/draft'); expect(fixtures.api.read).toHaveBeenCalledTimes(2);
});
test('descriptions persist as overrides, including explicit empty text, and restore per field', async () => {
  const described = { ...model('described', 'Described'), description: 'Directory text', catalog: { overrides: [] } }; snapshot.channels[0]!.models = [described]; snapshot.types[0]!.catalog = [described];
  await open(); await click('Described'); await commit('settings.models.modelDescription', 'My experience'); expect(lastSaved().models[0]).toMatchObject({ description: 'My experience', catalog: { overrides: ['description'] } });
  await commit('settings.models.modelDescription', ''); expect(lastSaved().models[0]).toMatchObject({ description: '', catalog: { overrides: ['description'] } }); await click('settings.models.fieldRestore'); expect(lastSaved().models[0]).toMatchObject({ description: 'Directory text', catalog: { overrides: [] } });
});
test.each([undefined, 'cloudflare-workers-ai-system-one'])('decision models inherit %s and keep editable path presets', async inherited => {
  snapshot.types[0]!.operations.push('decision'); snapshot.types[0]!.defaultParameters = { decisionApi: 'typesafe-system-one' }; snapshot.channels[0]!.parameters = inherited ? { decisionApi: inherited } : {}; snapshot.channels[0]!.connection!.paths!.decision = '/service-decision'; snapshot.channels[0]!.models = [{ ...model(), operations: ['decision'] }, { ...model('other', 'Other'), operations: ['decision'] }];
  await open(); await click('Model'); expect(field('settings.models.decisionPath').value).toBe('/service-decision'); const api = inherited ? 'typesafe-system-one' : 'cloudflare-workers-ai-system-one'; await select(inherited ?? 'typesafe-system-one', api); expect(field('settings.models.decisionPath').value).toBe(inherited ? '/systemone' : '/run'); await commit('settings.models.decisionPath', '/custom');
  expect(lastSaved()).toMatchObject({ connection: { paths: { decision: '/service-decision' } }, models: [{ decision: { api, paths: { classify: '/custom' } } }, { id: 'other' }] });
});
test('image and llama.cpp paths keep inheritance and custom edits through protocol changes', async () => {
  snapshot.types[0]!.operations = ['chat', 'decision', 'image-generation', 'image-editing']; snapshot.types[0]!.defaultParameters = { decisionApi: 'typesafe-system-one' }; snapshot.channels[0]!.parameters = { imageApi: 'openai-images' }; snapshot.channels[0]!.connection!.paths!['image-generation'] = '/service-generate'; snapshot.channels[0]!.models = [{ ...model(), operations: ['image-generation', 'image-editing', 'decision'], image: { mask: false } }];
  await open(); await click('Model'); expect(field('settings.models.imageGenerationPath').value).toBe('/service-generate'); await select('openai-images', 'openrouter-images'); expect(field('settings.models.imageGenerationPath').value).toBe('/chat/completions'); await commit('settings.models.imageGenerationPath', '/custom'); await commit('settings.models.imageGenerationPath', ''); expect(field('settings.models.imageGenerationPath').value).toBe('/service-generate'); expect(lastSaved().models[0]!.image?.mask).toBe(false);
  await select('typesafe-system-one', 'llama-cpp-classify'); for (const [key, path] of [['tokenize', '/tokenize'], ['applyTemplate', '/apply-template'], ['completion', '/completion']]) { expect(field(`settings.models.${key}Path`).value).toBe(path); await commit(`settings.models.${key}Path`, `/custom${path}`); }
  expect(lastSaved().models[0]!.decision?.paths).toEqual({ tokenize: '/custom/tokenize', applyTemplate: '/custom/apply-template', completion: '/custom/completion' });
});
test('invalid capacity and pricing stay local; coherent effort and capability edits save', async () => {
  snapshot.channels[0]!.models = [model()]; await open(); await click('Model'); await commit('settings.models.context', '-1'); expect(fixtures.api.save).not.toHaveBeenCalled(); expect(field('settings.models.context').getAttribute('aria-invalid')).toBe('true'); await commit('usage.input USD', '-2'); expect(fixtures.api.save).not.toHaveBeenCalled();
  await click('settings.models.reasoning'); expect(fixtures.api.save).not.toHaveBeenCalled(); await click('settings.agents.thinking.low'); await click('settings.agents.thinking.high'); await click('settings.models.imageInput'); await commit('settings.models.context', '128000'); expect(lastSaved().models[0]).toMatchObject({ reasoning: true, thinking: { mode: 'levels', levels: ['low', 'high'], allowOff: true }, input: ['text', 'image'], contextWindow: 128000 });
});
test('usage labels distinguish exact channel bindings', async () => {
  snapshot.channels[0]!.models = [model()]; fixtures.api.readSettings.mockResolvedValue({ global: { defaultProvider: 'channel', defaultModel: 'model', utilityModel: { providerId: 'channel', modelId: 'model' }, harness: { models: { worker: { providerId: 'elsewhere', modelId: 'model' } }, delegationModelSelection: { model: { providerId: 'channel', modelId: 'model' } } } } });
  await open(); expect(container.textContent).toContain('settings.models.usageDefault'); expect(container.textContent).toContain('settings.models.usageUtility'); expect(container.textContent).toContain('settings.models.usageDelegation'); expect(container.textContent).not.toContain('/ worker');
});

test('manual metadata resolves asynchronously, preserves edits, and refreshes after changing upstream ID', async () => {
  let finish!: (value: unknown) => void;
  const manual = { ...model('team/DEEPSEEK-FLASH-fast'), name: 'Manual', catalog: { overrides: [] } };
  snapshot.channels[0]!.models = [manual];
  fixtures.api.directory.mockImplementation(async (_type, _signal, _channel, requests) => {
    if (!requests[0].requestModelId) return new Promise(resolve => { finish = resolve; });
    return { models: [{ ...requests[0], name: 'Matched new', enabled: false, operations: ['chat'], contextWindow: 200000, maxOutputTokens: 8000, reasoning: false, catalog: { overrides: [] } }], status: { revision: 'directory', refreshing: false } };
  });
  await open(); await click('Manual'); await commit('settings.models.context', '123456');
  await act(async () => finish({ models: [{ ...manual, contextWindow: 1000000, maxOutputTokens: 32000, reasoning: true, thinking: { mode: 'levels', levels: ['low', 'high'], allowOff: true } }], status: { revision: 'directory', refreshing: false } }));
  expect(field('settings.models.context').value).toBe('123456'); expect(field('settings.models.output').value).toBe('32000');
  await commit('settings.models.requestModelId', 'new/GPT-4.1-mini');
  expect(field('settings.models.context').value).toBe('123456'); expect(field('settings.models.output').value).toBe('8000');
  await commit('settings.models.modelDescription', 'My explicit description');
  expect(lastSaved().models[0]).toMatchObject({ requestModelId: 'new/GPT-4.1-mini', contextWindow: 123456, description: 'My explicit description', reasoning: false });
});

test('catalog metadata acquired by an older manual model preserves its first explicit description edit', async () => {
  snapshot.channels[0]!.models = [model()]; snapshot.types[0]!.catalog = [{ ...model(), description: 'Directory description' }];
  await open(); await click('Model'); await commit('settings.models.modelDescription', 'Mine');
  expect(lastSaved().models[0]).toMatchObject({ description: 'Mine', catalog: { overrides: expect.arrayContaining(['description']) } });
});

test('a model focus intent opens its service and drawer instead of the first service', async () => {
  snapshot.channels.push({ ...snapshot.channels[0]!, id: 'second', name: 'Second service', models: [model('wanted', 'Wanted model')] });
  fixtures.focus = { channelId: 'second', modelId: 'wanted' };
  await act(async () => root.render(<ModelConnectionsPage />));
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Wanted model');
  expect(field('settings.models.modelDescription')).toBeTruthy(); expect(fixtures.focus).toBeNull();
});

test('restoring a field replaces an unfinished invalid edit and clears its error', async () => {
  snapshot.channels[0]!.models = [{ ...model(), contextWindow: 65536, catalog: { overrides: ['contextWindow'] } }];
  snapshot.types[0]!.catalog = [{ ...model(), contextWindow: 128000 }];
  await open(); await click('Model'); await commit('settings.models.context', '-1');
  expect(field('settings.models.context').getAttribute('aria-invalid')).toBe('true'); await click('settings.models.fieldRestore');
  expect(field('settings.models.context').value).toBe('128000'); expect(field('settings.models.context').getAttribute('aria-invalid')).toBe('false');
});
