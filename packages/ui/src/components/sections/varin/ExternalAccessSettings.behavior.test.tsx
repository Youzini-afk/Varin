import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  host: 1,
  listeners: new Set<() => void>(),
  events: new Set<(event: { type: string }) => void>(),
  fetch: vi.fn(),
  copy: vi.fn(),
  open: vi.fn(),
  translate: (key: string, params?: Record<string, unknown>) => `${key}${params ? ` ${JSON.stringify(params)}` : ''}`,
}));
vi.mock('@varin/application-client', () => ({
  runtimeFetch: fixture.fetch,
  getRuntimeEndpointGeneration: () => fixture.host,
  subscribeRuntimeEndpointChanged: (callback: () => void) => { fixture.listeners.add(callback); return () => { fixture.listeners.delete(callback); }; },
}));
vi.mock('@/components/sections/shared/SettingsPageLink', () => ({ SettingsPageLink: ({ children, page }: React.PropsWithChildren<{ page: string }>) => <button data-page={page}>{children}</button> }));
vi.mock('@/components/auth/BrowserSessionSignOut', () => ({ BrowserSessionSignOut: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.translate, locale: 'en' }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (callback: (event: { type: string }) => void) => { fixture.events.add(callback); return () => { fixture.events.delete(callback); }; } }));
vi.mock('@/lib/url', () => ({ openExternalUrl: fixture.open }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,cXI=' } }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
}));
vi.mock('@/components/ui/input', () => ({
  Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} />,
}));
vi.mock('@/components/sections/shared/SettingsSection', () => ({
  SETTINGS_FIELD_LABEL_CLASS: '', SETTINGS_HELPER_CLASS: '', SETTINGS_SELECT_SIZE: 'settings',
  SettingsFieldRow: ({ label, description, children }: React.PropsWithChildren<{ label: React.ReactNode; description: React.ReactNode }>) => <div>{label}<p>{description}</p>{children}</div>,
  SettingsSection: ({ title, description, headerAction, children }: React.PropsWithChildren<{ title: React.ReactNode; description: React.ReactNode; headerAction: React.ReactNode }>) =>
    <section><h2>{title}</h2><p>{description}</p>{headerAction}{children}</section>,
}));
vi.mock('@/components/ui/collapsible', () => {
  const Toggle = React.createContext<() => void>(() => {});
  return {
    Collapsible: ({ children, open, onOpenChange }: React.PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>) =>
      <Toggle.Provider value={() => onOpenChange(!open)}><div>{children}</div></Toggle.Provider>,
    CollapsibleTrigger: ({ children }: React.PropsWithChildren) => <button onClick={React.useContext(Toggle)}>{children}</button>,
    CollapsibleContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  };
});
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, onOpenChange }: React.PropsWithChildren<{ onOpenChange: (open: boolean) => void }>) =>
    <div role="dialog">{children}<button onClick={() => onOpenChange(false)}>Close dialog</button></div>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange, disabled }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void; disabled: boolean }>) =>
    <select value={value} disabled={disabled} onInput={event => onValueChange(event.currentTarget.value)}>{children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SelectItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => <option value={value}>{children}</option>,
}));

import { ExternalAccessSettings } from './ExternalAccessSettings';

const prefix = 'settings.varin.externalAccess.';
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const saved = (revision = 1, name = 'Home') => ({
  entry: { revision, enabled: false, configuration: { id: 'entry-1', name, provider: 'reverse-proxy', publicOrigin: 'https://home.example.com', backend: { host: '127.0.0.1', port: 3100 } } },
  phase: 'disabled', source: 'settings', listener: null, hostName: 'Actual Home Host',
});
const listening = (revision = 2) => ({ ...saved(revision), entry: { ...saved(revision).entry, enabled: true }, phase: 'unverified',
  listener: { host: '127.0.0.1', port: 3100, origin: 'https://home.example.com' } });
let root: Root, container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks(); fixture.host += 1;
  fixture.copy.mockResolvedValue(undefined);
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('navigator', { clipboard: { writeText: fixture.copy } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => root.render(<ExternalAccessSettings />)); };
const button = (key: string) => {
  const found = [...container.querySelectorAll('button')].find(element => element.textContent === prefix + key);
  expect(found, `button ${key}`).toBeTruthy();
  return found!;
};
const click = async (key: string) => {
  const target = button(key); expect(target.disabled).toBe(false);
  await act(async () => {
    target.click();
    // linkedom does not implement a submit button's native default action.
    if (target.type === 'submit') target.closest('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
};
const field = (name: string) => container.querySelector<HTMLInputElement>(`input[id$="-${name}"]`)!;
const edit = async (name: string, value: string) => { await act(async () => {
  field(name).value = value; field(name).dispatchEvent(new window.Event('input', { bubbles: true }));
}); };
const body = (call: number) => JSON.parse(fixture.fetch.mock.calls[call][1].body);

it('offers an explicit apply action for saved changes while the old entry is running', async () => {
  fixture.fetch.mockResolvedValueOnce(response({ ...listening(3), phase: 'enabled', activeRevision: 2 }))
    .mockResolvedValueOnce(response({ ...listening(3), phase: 'enabled', activeRevision: 3 }));
  await mount();
  await click('applySaved');
  expect(fixture.fetch.mock.calls[1][0]).toBe('/api/varin/external-access/retry');
  expect(body(1)).toEqual({ expectedRevision: 3 });
  expect(container.textContent).not.toContain(prefix + 'applySaved');
});

it('saves a draft without enabling it and only reports the real listener as unverified after enable', async () => {
  fixture.fetch.mockResolvedValueOnce(response({ entry: null, phase: 'disabled', source: 'settings', listener: null }))
    .mockResolvedValueOnce(response(saved())).mockResolvedValueOnce(response(listening()));
  await mount();
  await edit('origin', 'https://home.example.com/');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  await click('save');
  expect(fixture.fetch.mock.calls[1][0]).toBe('/api/varin/external-access');
  expect(fixture.fetch.mock.calls[1][1].method).toBe('PUT');
  expect(body(1)).toEqual({ expectedRevision: null, configuration: { name: '', provider: 'reverse-proxy', publicOrigin: 'https://home.example.com', backend: { host: '127.0.0.1', port: 3100 } } });
  expect(container.textContent).toContain(prefix + 'phase.disabled');
  expect(container.textContent).not.toContain(prefix + 'notListening');
  await click('details');
  expect(container.textContent).toContain(prefix + 'notListening');
  expect(button('addBrowser').disabled).toBe(true);
  await click('enable');
  expect(fixture.fetch.mock.calls[2][0]).toBe('/api/varin/external-access/enable');
  expect(body(2)).toEqual({ expectedRevision: 1 });
  expect(container.textContent).toContain(prefix + 'phase.unverified');
  expect(container.textContent).toContain(prefix + 'unverifiedHint');
  expect(container.textContent).toContain('http://127.0.0.1:3100');
  expect(button('addBrowser').disabled).toBe(false);
});

it('keeps a conflicted draft and requires an explicit rebase plus a new save, never an automatic overwrite', async () => {
  fixture.fetch.mockResolvedValueOnce(response(saved())).mockResolvedValueOnce(response({ error: 'stale revision' }, 409))
    .mockResolvedValueOnce(response(saved(2, 'Other device'))).mockResolvedValueOnce(response(saved(3, 'My draft')));
  await mount(); await edit('name', 'My draft'); await click('save');
  expect(field('name').value).toBe('My draft');
  expect(container.textContent).toContain('Other device');
  expect(container.textContent).toContain(prefix + 'conflict');
  expect(button('save').disabled).toBe(true);
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  await click('keepDraft');
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  await click('save');
  expect(body(3).expectedRevision).toBe(2);
  expect(body(3).configuration.name).toBe('My draft');
});

it('preserves drafts during refresh and lets the user explicitly discard them for a new remote version', async () => {
  fixture.fetch.mockResolvedValueOnce(response(saved())).mockResolvedValueOnce(response(saved(4, 'Remote')));
  await mount(); await edit('name', 'Draft'); await click('refresh');
  expect(field('name').value).toBe('Draft'); expect(button('save').disabled).toBe(true);
  await click('useLatest');
  expect(field('name').value).toBe('Remote');
  expect(container.textContent).not.toContain(prefix + 'conflict');
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});

it('does not replay a write with an unknown result and keeps its draft until status is reconciled', async () => {
  fixture.fetch.mockResolvedValueOnce(response(saved())).mockRejectedValueOnce(new TypeError('network lost'))
    .mockResolvedValueOnce(response(saved(2, 'Saved elsewhere')));
  await mount(); await edit('name', 'Draft'); await click('save');
  expect(container.textContent).toContain(prefix + 'outcomeUnknown');
  expect(button('save').disabled).toBe(true); expect(fixture.fetch).toHaveBeenCalledTimes(2);
  await click('refresh');
  expect(field('name').value).toBe('Draft'); expect(container.textContent).toContain(prefix + 'conflict');
  expect(fixture.fetch.mock.calls[2][1].method).toBeUndefined();
});

it('distinguishes startup failure from public verification and uses the revision for retry and disable', async () => {
  fixture.fetch.mockResolvedValueOnce(response({ ...listening(), phase: 'failed', listener: null, error: 'Port is in use' }))
    .mockResolvedValueOnce(response(listening(3))).mockResolvedValueOnce(response(saved(4)));
  await mount();
  expect(container.textContent).toContain('Port is in use'); expect(container.textContent).toContain(prefix + 'phase.failed');
  await click('retry');
  expect(fixture.fetch.mock.calls[1][0]).toBe('/api/varin/external-access/retry'); expect(body(1).expectedRevision).toBe(2);
  await click('disable');
  expect(fixture.fetch.mock.calls[2][0]).toBe('/api/varin/external-access/disable'); expect(body(2).expectedRevision).toBe(3);
  expect(container.textContent).toContain(prefix + 'phase.disabled');
});

it.each(['environment', 'frp'])('does not expose an overwrite form for %s-managed or redacted entries', async mode => {
  const snapshot = saved();
  if (mode === 'environment') snapshot.source = 'environment'; else snapshot.entry.configuration.provider = 'frp';
  fixture.fetch.mockResolvedValueOnce(response(snapshot)); await mount();
  expect(container.querySelector('form')).toBeNull();
  expect(container.textContent).toContain(prefix + (mode === 'environment' ? 'environmentManaged' : 'frpManaged'));
  expect([...container.querySelectorAll('button')].some(element => element.textContent === prefix + 'enable')).toBe(mode === 'frp');
});

it('shows an environment-managed active listener and browser pairing without inventing a saved entry', async () => {
  fixture.fetch.mockResolvedValueOnce(response({ ...listening(), source: 'environment', entry: null }));
  await mount();
  expect(container.textContent).toContain('https://home.example.com');
  expect(container.textContent).toContain(prefix + 'phase.unverified');
  expect(button('addBrowser').disabled).toBe(false); expect(container.querySelector('form')).toBeNull();
});

it.each(['starting', 'reconnecting'])('allows disabling %s intent without discarding an unsaved draft', async phase => {
  fixture.fetch.mockResolvedValueOnce(response({ ...listening(), phase })).mockResolvedValueOnce(response(saved(3)));
  await mount(); await edit('name', 'Keep this draft');
  expect(button('save').disabled).toBe(true); await click('disable');
  expect(fixture.fetch.mock.calls[1][0]).toBe('/api/varin/external-access/disable');
  expect(field('name').value).toBe('Keep this draft'); expect(button('save').disabled).toBe(false);
});

it('explains local management authorization when an owner cannot mutate from a public connection', async () => {
  fixture.fetch.mockResolvedValueOnce(response(saved())).mockResolvedValueOnce(response({ error: 'local only' }, 403));
  await mount(); await click('enable');
  expect(container.textContent).toContain(prefix + 'ownerRequired');
  expect(container.textContent).toContain(prefix + 'phase.disabled');
});

it('drops the prior Host’s draft, link and late response on a Host switch', async () => {
  let old!: (response: Response) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
  await mount();
  fixture.fetch.mockResolvedValueOnce(response(saved(9, 'New Host')));
  await act(async () => { fixture.host += 1; fixture.listeners.forEach(callback => callback()); });
  expect(field('name').value).toBe('New Host');
  await act(async () => old(response(saved(1, 'Old Host'))));
  expect(field('name').value).toBe('New Host');
});

it('creates browser-only persistent pairing with explicit expiration policy and copies only on request', async () => {
  const url = 'https://home.example.com/connect/browser#one-time-fixture';
  fixture.fetch.mockResolvedValueOnce(response(listening())).mockResolvedValueOnce(response({ browserUrl: url,
    pairing: { expiresAt: new Date(Date.now() + 60_000).toISOString(), clientExpiresAt: null } }, 201));
  await mount(); await click('addBrowser');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  await act(async () => { button('pairing.create').click(); button('pairing.create').click(); });
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(fixture.fetch.mock.calls[1][0]).toBe('/api/client-auth/pairing/sessions');
  expect(body(1).allowedClientKinds).toEqual(['browser']); expect(body(1).clientExpiresAt).toBeNull();
  expect(Date.parse(body(1).expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
  expect(fixture.copy).not.toHaveBeenCalled();
  await click('pairing.copy'); expect(fixture.copy).toHaveBeenCalledWith(url);
  await act(async () => [...container.querySelectorAll('button')].find(element => element.textContent === 'Close dialog')!.click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('input[readonly]')).toBeNull();
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});

it('fixes a temporary device deadline at link creation, separately from the one-time link deadline', async () => {
  fixture.fetch.mockResolvedValueOnce(response(listening())).mockResolvedValueOnce(response({ error: 'blocked' }, 403));
  await mount(); await click('addBrowser');
  await act(async () => {
    const select = container.querySelector('[role="dialog"] select')!;
    select.querySelectorAll('option').forEach(option => { option.selected = option.value === 'temporary'; });
    select.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await click('pairing.create');
  const request = body(1);
  expect(Date.parse(request.clientExpiresAt) - Date.now()).toBeGreaterThan(7.9 * 3_600_000);
  expect(Date.parse(request.clientExpiresAt) - Date.parse(request.expiresAt)).toBe(7.5 * 3_600_000);
  expect(container.textContent).toContain(prefix + 'pairing.failed');
});

it('does not automatically retry pairing after a lost response or expose a stale pairing result after dismissal', async () => {
  fixture.fetch.mockResolvedValueOnce(response(listening())).mockRejectedValueOnce(new TypeError('offline'));
  await mount(); await click('addBrowser'); await click('pairing.create');
  expect(button('pairing.create').disabled).toBe(true); expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain(prefix + 'pairing.unknown');
  await act(async () => [...container.querySelectorAll('button')].find(element => element.textContent === 'Close dialog')!.click());
  let done!: (value: Response) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  await click('addBrowser');
  await act(async () => button('pairing.create').click());
  await act(async () => [...container.querySelectorAll('button')].find(element => element.textContent === 'Close dialog')!.click());
  await act(async () => done(response({ browserUrl: 'https://home.example.com/connect/browser#late-fixture', pairing: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }, 201)));
  expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(fixture.copy).not.toHaveBeenCalled();
});

const frpSettings = () => ({
  server: { address: 'frp.example.com', port: 7000, tls: { caFile: '/etc/varin/ca.pem', serverName: 'frp.example.com' } },
  proxy: { name: 'varin', remotePort: 7300 }, tokenEnv: 'VARIN_FRP_TOKEN_HOME',
});
const frpSaved = (revision = 1) => ({ ...saved(revision), entry: { ...saved(revision).entry,
  configuration: { ...saved(revision).entry.configuration, provider: 'frp', frp: frpSettings() } } });
const chooseProvider = async (provider: string) => { await act(async () => {
  const select = container.querySelector('form select')!;
  select.querySelectorAll('option').forEach(option => { option.selected = false; });
  select.querySelector<HTMLOptionElement>(`option[value="${provider}"]`)!.selected = true;
  select.dispatchEvent(new window.Event('input', { bubbles: true }));
}); };

it('creates an existing FRP entry using only operator settings and a token environment reference, without enabling it', async () => {
  fixture.fetch.mockResolvedValueOnce(response({ entry: null, phase: 'disabled', source: 'settings', listener: null }))
    .mockResolvedValueOnce(response(frpSaved()));
  await mount(); await chooseProvider('frp');
  await edit('origin', 'https://home.example.com'); await edit('serverAddress', 'frp.example.com');
  await edit('serverName', 'frp.example.com'); await edit('caFile', '/etc/varin/ca.pem'); await edit('tokenEnv', 'VARIN_FRP_TOKEN_HOME');
  expect(container.textContent).toContain(prefix + 'frp.secretHint');
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await click('save');
  expect(body(1)).toEqual({ expectedRevision: null, configuration: {
    name: '', provider: 'frp', publicOrigin: 'https://home.example.com', backend: { host: '127.0.0.1', port: 3100 }, frp: frpSettings(),
  } });
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain(prefix + 'phase.disabled');
});

it('loads and replaces an existing FRP configuration using its original revision', async () => {
  fixture.fetch.mockResolvedValueOnce(response(frpSaved(4))).mockResolvedValueOnce(response(frpSaved(5)));
  await mount(); expect(field('caFile').value).toBe('/etc/varin/ca.pem'); expect(field('tokenEnv').value).toBe('VARIN_FRP_TOKEN_HOME');
  await edit('remotePort', '19090'); await click('save');
  expect(body(1).expectedRevision).toBe(4);
  expect(body(1).configuration.frp).toEqual({ ...frpSettings(), proxy: { name: 'varin', remotePort: 19090 } });
});

it('preserves FRP fields on a conflicting replacement and requires review before using the latest revision', async () => {
  fixture.fetch.mockResolvedValueOnce(response(frpSaved(1))).mockResolvedValueOnce(response({}, 409))
    .mockResolvedValueOnce(response(frpSaved(2))).mockResolvedValueOnce(response(frpSaved(3)));
  await mount(); await edit('proxyName', 'new-proxy'); await click('save');
  expect(field('proxyName').value).toBe('new-proxy'); expect(button('save').disabled).toBe(true);
  await click('keepDraft'); await click('save');
  expect(body(3).expectedRevision).toBe(2); expect(body(3).configuration.frp.proxy.name).toBe('new-proxy');
});

it.each([['tokenEnv', 'raw-token-do-not-send'], ['host', '0.0.0.0'], ['serverPort', '65536']])('rejects invalid FRP %s without transmitting a mutation', async (name, value) => {
  fixture.fetch.mockResolvedValueOnce(response(frpSaved())); await mount(); await edit(name, value); await click('save');
  expect(fixture.fetch).toHaveBeenCalledTimes(1); expect(container.textContent).toContain(prefix + 'frp.invalid');
});


it('keeps external forwarding independent: only origin, name and backend are saved, without FRP controls', async () => {
  fixture.fetch.mockResolvedValueOnce(response({ entry: null, phase: 'disabled', source: 'settings', listener: null }))
    .mockResolvedValueOnce(response({ ...saved(), entry: { ...saved().entry, configuration: { ...saved().entry.configuration, provider: 'external-forwarding' } } }));
  await mount(); await chooseProvider('external-forwarding');
  expect(field('serverAddress')).toBeNull(); expect(field('tokenEnv')).toBeNull();
  expect(container.textContent).toContain(prefix + 'externalManagedHint');
  await edit('origin', 'https://home.example.com'); await edit('name', 'Home'); await click('save');
  expect(body(1).configuration).toEqual({ name: 'Home', provider: 'external-forwarding', publicOrigin: 'https://home.example.com', backend: { host: '127.0.0.1', port: 3100 } });
  expect(container.textContent).toContain(prefix + 'externalManagedStatus');
  expect(container.querySelector('select')!.value).toBe('external-forwarding');
  expect(button('save').disabled).toBe(true);
});

it('checks only on demand, serializes repeated clicks and preserves the unsaved draft', async () => {
  let done!: (value: Response) => void;
  fixture.fetch.mockResolvedValueOnce(response({ ...listening(), phase: 'enabled' }))
    .mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  await mount();
  expect(container.textContent).toContain('Actual Home Host');
  expect(container.textContent).not.toContain(prefix + 'actualListener');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  await edit('name', 'Draft survives a diagnostic');
  await act(async () => { button('checkAccess').click(); button('checkAccess').click(); });
  expect(button('checking').disabled).toBe(true); expect(button('disable').disabled).toBe(true);
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(fixture.fetch.mock.calls[1][0]).toBe('/api/varin/external-access/check');
  expect(fixture.fetch.mock.calls[1][1]).toEqual({ method: 'POST', headers: { Accept: 'application/json' } });
  await act(async () => done(response({ ...listening(), phase: 'enabled', accessCheck: { state: 'verified', origin: 'https://home.example.com', checkedAt: Date.now() } })));
  expect(container.textContent).toContain(prefix + 'check.verified');
  expect(container.textContent).toContain(prefix + 'phase.enabled');
  expect(field('name').value).toBe('Draft survives a diagnostic');
  await click('details'); expect(container.textContent).not.toContain(prefix + 'check.verified');
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});

it('a failed public check does not stop forwarding or block disabling the entry', async () => {
  fixture.fetch.mockResolvedValueOnce(response(listening())).mockResolvedValueOnce(response({ ...listening(), accessCheck: {
    state: 'unverified', checkedAt: Date.now(), origin: 'https://home.example.com', reason: 'tls',
  } })).mockResolvedValueOnce(response(saved(3)));
  await mount(); await click('checkAccess');
  expect(container.textContent).toContain(prefix + 'check.tls');
  expect(container.textContent).toContain(prefix + 'phase.unverified');
  expect(button('disable').disabled).toBe(false);
  await click('disable');
  expect(fixture.fetch.mock.calls[2][0]).toBe('/api/varin/external-access/disable');
  expect(button('checkAccess').disabled).toBe(true);
});

it('reports a rejected check without retrying automatically or replaying configuration', async () => {
  fixture.fetch.mockResolvedValueOnce(response(listening())).mockResolvedValueOnce(response({}, 403));
  await mount(); await click('checkAccess');
  expect(container.textContent).toContain(prefix + 'ownerRequired');
  expect(button('disable').disabled).toBe(false); expect(button('checkAccess').disabled).toBe(false);
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});

it('drops late diagnostics and closes deployment details when the current Host changes', async () => {
  let done!: (value: Response) => void;
  fixture.fetch.mockResolvedValueOnce(response(listening())).mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  await mount(); await act(async () => button('checkAccess').click()); await click('deploymentFiles');
  fixture.fetch.mockResolvedValueOnce(response({ ...saved(9, 'New entry'), hostName: 'New actual Host' }));
  await act(async () => { fixture.host += 1; fixture.listeners.forEach(callback => callback()); });
  await act(async () => done(response({ ...listening(), accessCheck: { state: 'verified', checkedAt: Date.now(), origin: 'https://home.example.com' } })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain('New actual Host'); expect(container.textContent).not.toContain('Actual Home Host');
  expect(container.textContent).not.toContain(prefix + 'check.verified');
});

it('opens deployment files without contacting the VPS and copies only saved non-sensitive setup', async () => {
  fixture.fetch.mockResolvedValueOnce(response({ ...frpSaved(), hostName: 'Actual Home Host', token: 'secret-not-for-copy', connectUrl: 'https://home.example.com/#pairing-secret' }));
  await mount(); await edit('origin', 'https://unsaved.example.com'); await click('deploymentFiles');
  expect(fixture.fetch).toHaveBeenCalledTimes(1); expect(fixture.copy).not.toHaveBeenCalled();
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Actual Home Host'); expect(dialog.textContent).not.toContain('unsaved.example.com');
  expect(dialog.textContent).not.toContain('VARIN_FRP_TOKEN_HOME'); expect(dialog.textContent).not.toContain('/etc/varin/ca.pem');
  await click('deployment.copyForAgent');
  expect(fixture.copy).toHaveBeenCalledWith('Host: Actual Home Host\nPublic HTTPS origin: https://home.example.com\nHost backend listener: http://127.0.0.1:3100\nDeployment files: https://github.com/Astrmira/Varin/tree/main/deploy/external-access');
  await click('deployment.caddy'); expect(fixture.open).toHaveBeenLastCalledWith('https://github.com/Astrmira/Varin/tree/main/deploy/external-access/snippets/Caddyfile');
  await click('deployment.nginx'); expect(fixture.open).toHaveBeenLastCalledWith('https://github.com/Astrmira/Varin/tree/main/deploy/external-access/snippets/nginx.conf');
  await act(async () => [...container.querySelectorAll('button')].find(element => element.textContent === 'Close dialog')!.click());
  expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(fixture.fetch).toHaveBeenCalledTimes(1);
});

it('keeps deployment guidance available after a status error and handles failed clipboard access', async () => {
  fixture.fetch.mockRejectedValueOnce(new TypeError('offline')); fixture.copy.mockRejectedValueOnce(new Error('denied'));
  await mount(); await click('deploymentFiles'); await click('deployment.copyForAgent');
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain(prefix + 'copyFailed');
  expect(fixture.copy).toHaveBeenCalledWith('Deployment files: https://github.com/Astrmira/Varin/tree/main/deploy/external-access');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});


it('observes Host status transitions without polling or replacing a draft', async () => {
  fixture.fetch.mockResolvedValueOnce(response(listening())).mockResolvedValueOnce(response({ ...listening(), phase: 'connected' }))
    .mockResolvedValueOnce(response(saved(4, 'Other client')));
  await mount(); await edit('name', 'Draft');
  await act(async () => fixture.events.forEach(listener => listener({ type: 'external-access-changed' })));
  expect(container.textContent).toContain(prefix + 'phase.connected'); expect(field('name').value).toBe('Draft');
  expect(button('save').disabled).toBe(false);
  await act(async () => fixture.events.forEach(listener => listener({ type: 'stream-ready' })));
  expect(container.textContent).toContain(prefix + 'conflict'); expect(field('name').value).toBe('Draft');
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
});

it('coalesces status events during a mutation and reconciles after its own revision has been accepted', async () => {
  let savedResponse!: (value: Response) => void;
  fixture.fetch.mockResolvedValueOnce(response(saved())).mockImplementationOnce(() => new Promise(resolve => { savedResponse = resolve; }))
    .mockResolvedValueOnce(response(saved(2, 'Saved draft')));
  await mount(); await edit('name', 'Saved draft');
  await act(async () => {
    button('save').closest('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    fixture.events.forEach(listener => { listener({ type: 'external-access-changed' }); listener({ type: 'external-access-changed' }); });
  });
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  await act(async () => savedResponse(response(saved(2, 'Saved draft'))));
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  expect(container.textContent).not.toContain(prefix + 'conflict'); expect(field('name').value).toBe('Saved draft');
});

it('inspects and installs a Host component only after separate user actions, never while saving', async () => {
  const missing = { state: 'missing', source: null, version: null, managedVersion: '0.69.1', installSupported: true };
  let installed!: (value: Response) => void;
  fixture.fetch.mockResolvedValueOnce(response(frpSaved())).mockResolvedValueOnce(response(missing))
    .mockImplementationOnce(() => new Promise(resolve => { installed = resolve; }));
  await mount(); expect(fixture.fetch).toHaveBeenCalledTimes(1);
  await click('component.check');
  expect(fixture.fetch.mock.calls[1][0]).toBe('/api/varin/external-access/component');
  expect(fixture.fetch.mock.calls[1][1].method).toBe('GET');
  await edit('name', 'Draft');
  await act(async () => { button('component.install').click(); button('component.install').click(); });
  expect(fixture.fetch).toHaveBeenCalledTimes(3); expect(button('save').disabled).toBe(true);
  expect(fixture.fetch.mock.calls[2][0]).toBe('/api/varin/external-access/component/install');
  expect(fixture.fetch.mock.calls[2][1]).toEqual({ method: 'POST', headers: { Accept: 'application/json' } });
  await act(async () => installed(response({ ...missing, state: 'available', source: 'managed', version: '0.69.1', executablePath: '/host/frpc' })));
  expect(container.textContent).toContain('/host/frpc'); expect(button('save').disabled).toBe(false);
  expect(field('name').value).toBe('Draft'); expect(fixture.fetch).toHaveBeenCalledTimes(3);
});

it('does not replay an unknown component install and requires a new inspection', async () => {
  const missing = { state: 'missing', source: null, version: null, managedVersion: '0.69.1', installSupported: true };
  fixture.fetch.mockResolvedValueOnce(response(frpSaved())).mockResolvedValueOnce(response(missing)).mockRejectedValueOnce(new TypeError('lost'))
    .mockResolvedValueOnce(response(missing));
  await mount(); await click('component.check'); await click('component.install');
  expect(button('component.install').disabled).toBe(true); expect(container.textContent).toContain(prefix + 'component.unknown');
  await click('component.check'); expect(button('component.install').disabled).toBe(false);
  expect(fixture.fetch).toHaveBeenCalledTimes(4);
});

it('copies the packaged proxy snippet unchanged only on click, and refuses an HTML fallback', async () => {
  fixture.fetch.mockResolvedValueOnce(response(saved())).mockResolvedValueOnce(new Response('# Configure your public hostname\nreverse_proxy 127.0.0.1:3100', { headers: { 'Content-Type': 'text/plain' } }))
    .mockResolvedValueOnce(new Response('<!doctype html><html>app fallback</html>', { headers: { 'Content-Type': 'text/html' } }));
  await mount(); await click('deploymentFiles');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  await click('deployment.copyCaddy');
  expect(fixture.fetch.mock.calls[1][0]).toBe('/downloads/varin-external-access/snippets/Caddyfile');
  expect(fixture.copy).toHaveBeenCalledWith('# Configure your public hostname\nreverse_proxy 127.0.0.1:3100');
  await click('deployment.copyNginx');
  expect(fixture.copy).toHaveBeenCalledTimes(1); expect(container.textContent).toContain(prefix + 'deployment.fileFailed');
});

it('does not copy a late snippet after closing deployment details', async () => {
  let done!: (value: Response) => void;
  fixture.fetch.mockResolvedValueOnce(response(saved())).mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  await mount(); await click('deploymentFiles'); await act(async () => button('deployment.copyCaddy').click());
  await act(async () => [...container.querySelectorAll('button')].find(element => element.textContent === 'Close dialog')!.click());
  await act(async () => done(new Response('# snippet', { headers: { 'Content-Type': 'text/plain' } })));
  expect(fixture.copy).not.toHaveBeenCalled(); expect(container.querySelector('[role="dialog"]')).toBeNull();
});


it('removes an entry only after explicit confirmation, preserving the original revision', async () => {
  fixture.fetch.mockResolvedValueOnce(response(listening())).mockResolvedValueOnce(response({ entry: null, source: 'settings', phase: 'disabled', listener: null }));
  await mount(); await click('remove');
  expect(fixture.fetch).toHaveBeenCalledTimes(1); expect(container.querySelector('[role="dialog"]')!.textContent).toContain(prefix + 'removeHint');
  await act(async () => [...container.querySelectorAll('button')].find(element => element.textContent === 'Close dialog')!.click());
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  await click('remove'); await click('confirmRemove');
  expect(fixture.fetch.mock.calls[1][0]).toBe('/api/varin/external-access');
  expect(fixture.fetch.mock.calls[1][1].method).toBe('DELETE'); expect(body(1)).toEqual({ expectedRevision: 2 });
  expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(field('origin').value).toBe('');
  expect(container.textContent).toContain(prefix + 'removed');
});

it('requires status reconciliation after an unknown remove outcome rather than retrying deletion', async () => {
  fixture.fetch.mockResolvedValueOnce(response(saved())).mockRejectedValueOnce(new TypeError('lost'));
  await mount(); await click('remove'); await click('confirmRemove');
  expect(button('confirmRemove').disabled).toBe(true); expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain(prefix + 'outcomeUnknown');
});


it('downloads only a validated packaged archive through the fixed same-origin path', async () => {
  const objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:kit-fixture');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const downloads: Array<{ href: string; name: string }> = [];
  const anchorClick = vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, name: this.download });
  });
  fixture.fetch.mockResolvedValueOnce(response(saved())).mockResolvedValueOnce(new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), { headers: { 'Content-Type': 'application/gzip' } }))
    .mockResolvedValueOnce(new Response('<html>not an archive</html>', { headers: { 'Content-Type': 'application/octet-stream' } }));
  await mount(); await click('deploymentFiles'); await click('deployment.download');
  expect(fixture.fetch.mock.calls[1][0]).toBe('/downloads/varin-external-access.tar.gz');
  expect(downloads).toEqual([{ href: 'blob:kit-fixture', name: 'varin-external-access.tar.gz' }]);
  expect(objectUrl).toHaveBeenCalledTimes(1);
  await click('deployment.download');
  expect(objectUrl).toHaveBeenCalledTimes(1); expect(container.textContent).toContain(prefix + 'deployment.fileFailed');
  anchorClick.mockRestore(); objectUrl.mockRestore(); revoke.mockRestore();
});

it('closes stale browser pairing when the entry is disabled by another client', async () => {
  fixture.fetch.mockResolvedValueOnce(response(listening())).mockResolvedValueOnce(response(saved(3))).mockResolvedValueOnce(response(listening(4)));
  await mount(); await click('addBrowser');
  await act(async () => fixture.events.forEach(listener => listener({ type: 'external-access-changed' })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => fixture.events.forEach(listener => listener({ type: 'external-access-changed' })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});


it('preserves exact customized Host pairing TTLs rather than replacing them with display-rounded presets', async () => {
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  fixture.fetch.mockResolvedValueOnce(response({ ...listening(), pairingDefaults: { linkTtlMs: 1_234_567, temporaryAccessTtlMs: 12_345_678 } }))
    .mockResolvedValueOnce(response({}, 403));
  await mount(); await click('addBrowser');
  await act(async () => {
    const select = container.querySelector('[role="dialog"] select')!;
    select.querySelectorAll('option').forEach(option => { option.selected = false; });
    select.querySelector<HTMLOptionElement>('option[value="temporary"]')!.selected = true;
    select.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const options = [...container.querySelectorAll<HTMLOptionElement>('[role="dialog"] option')].map(option => option.value);
  expect(options).toContain('1234567'); expect(options).toContain('12345678');
  await click('pairing.create');
  expect(Date.parse(body(1).expiresAt) - now).toBe(1_234_567);
  expect(Date.parse(body(1).clientExpiresAt) - now).toBe(12_345_678);
  clock.mockRestore();
});


it('retains empty settings generations for recreation and detects another client’s create-and-remove changes', async () => {
  fixture.fetch.mockResolvedValueOnce(response({ entry: null, settingsRevision: 5, source: 'settings', phase: 'disabled', listener: null }))
    .mockResolvedValueOnce(response({ entry: null, settingsRevision: 7, source: 'settings', phase: 'disabled', listener: null }))
    .mockResolvedValueOnce(response(saved(8)));
  await mount(); await edit('origin', 'https://home.example.com');
  await act(async () => fixture.events.forEach(listener => listener({ type: 'external-access-changed' })));
  expect(button('save').disabled).toBe(true); expect(container.textContent).toContain(prefix + 'conflict');
  await click('keepDraft'); await click('save');
  expect(body(2).expectedRevision).toBe(7);
});
