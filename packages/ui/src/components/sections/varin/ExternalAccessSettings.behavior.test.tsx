import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  host: 1,
  listeners: new Set<() => void>(),
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
vi.mock('@/components/auth/BrowserSessionSignOut', () => ({ BrowserSessionSignOut: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.translate, locale: 'en' }) }));
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
  SettingsSection: ({ title, description, headerAction, children }: React.PropsWithChildren<{ title: React.ReactNode; description: React.ReactNode; headerAction: React.ReactNode }>) =>
    <section><h2>{title}</h2><p>{description}</p>{headerAction}{children}</section>,
}));
vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: React.PropsWithChildren) => <button>{children}</button>,
  CollapsibleContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
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
  phase: 'disabled', source: 'settings', listener: null,
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
  proxy: { name: 'varin', remotePort: 18080 }, tokenEnv: 'VARIN_FRP_TOKEN_HOME',
});
const frpSaved = (revision = 1) => ({ ...saved(revision), entry: { ...saved(revision).entry,
  configuration: { ...saved(revision).entry.configuration, provider: 'frp', frp: frpSettings() } } });
const chooseProvider = async (provider: string) => { await act(async () => {
  const select = container.querySelector('form select')!;
  select.querySelectorAll('option').forEach(option => { option.selected = option.value === provider; });
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
