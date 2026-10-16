import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>(), fetch: vi.fn(), translate: (key: string) => key }));
vi.mock('@varin/application-client', () => ({ runtimeFetch: fixture.fetch, registerRuntimeEndpointSwitchBlocker: vi.fn(),
  getRuntimeEndpointGeneration: () => fixture.generation, getRuntimeApiBaseUrl: () => `https://host-${fixture.generation}.example`,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.translate }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={event => onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>)} /> }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section>, SettingsFieldRow: ({ children, label }: React.PropsWithChildren<{ label: string }>) => <label data-field={label}>{children}</label> }));
vi.mock('@/components/ui/select', () => ({ Select: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectValue: () => null, SelectItem: ({ children }: React.PropsWithChildren) => <span>{children}</span> }));
import { OutboundNetworkSettings } from './OutboundNetworkSettings';

let root: Root, container: HTMLDivElement;
const settings = () => ({ outboundNetwork: { mode: 'proxy', proxyUrl: `https://proxy-${fixture.generation}.example/`, noProxy: '', credentialRef: `ref-${fixture.generation}` } });
const field = (name: string) => container.querySelector<HTMLInputElement>(`[data-field="settings.page.harness.network.${name}"] input`)!;
const button = (key: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === key)!;
const input = (name: string, value: string) => act(async () => { field(name).value = value; field(name).dispatchEvent(new window.Event('input', { bubbles: true })); });
const switchHost = () => act(async () => { fixture.generation += 1; for (const listener of fixture.listeners) listener(); });
const credentialsWrites = () => fixture.fetch.mock.calls.filter(([url, init]) => url.endsWith('/credentials') && init?.method === 'PUT');
beforeEach(() => {
  vi.clearAllMocks(); fixture.generation += 1;
  fixture.fetch.mockImplementation(async (url: string) => Response.json(url.endsWith('/settings') ? settings() : { configured: false }));
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<OutboundNetworkSettings />));

it('does not combine an old settings response with credentials from a replacement Host', async () => {
  let oldRead!: (value: Response) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(resolve => { oldRead = resolve; }));
  await render(); await switchHost();
  await act(async () => oldRead(Response.json({ outboundNetwork: { mode: 'proxy', proxyUrl: 'https://old.invalid/', noProxy: '' } })));
  expect(field('proxyUrl').value).toBe(`https://proxy-${fixture.generation}.example/`);
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/credentials'))).toHaveLength(1);
});

it('sends each save once and never sends its credential follow-up after a Host switch', async () => {
  await render(); await input('username', 'fixture-user'); await input('password', 'fixture-password');
  let complete!: (value: Response) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => { button('settings.common.actions.saveChanges').click(); button('settings.common.actions.saveChanges').click(); });
  expect(fixture.fetch.mock.calls.filter(([url, init]) => url.endsWith('/settings') && init?.method === 'PUT')).toHaveLength(1);
  await switchHost();
  await act(async () => complete(Response.json({ outboundNetwork: { mode: 'proxy', proxyUrl: 'https://old.invalid/', noProxy: '', credentialRef: 'old-secret-ref' } })));
  expect(credentialsWrites()).toHaveLength(0);
  expect(field('username').value).toBe(''); expect(field('password').value).toBe('');
  expect(field('proxyUrl').value).toBe(`https://proxy-${fixture.generation}.example/`);
});

it('binds credentials to the acknowledged configuration and retains failed credential edits until cancel', async () => {
  await render(); await input('username', 'fixture-user'); await input('password', 'fixture-password');
  fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/settings')) return Response.json({ outboundNetwork: { ...settings().outboundNetwork, credentialRef: 'saved-config-reference' } });
    if (init?.method === 'PUT') return Response.json({ error: 'fixture failure' }, { status: 409 });
    return Response.json({ configured: false });
  });
  await act(async () => button('settings.common.actions.saveChanges').click());
  expect(credentialsWrites()).toHaveLength(1);
  expect(JSON.parse(credentialsWrites()[0][1].body)).toEqual({ username: 'fixture-user', password: 'fixture-password', credentialRef: 'saved-config-reference' });
  expect(field('password').value).toBe('fixture-password'); expect(button('settings.common.actions.saveChanges').disabled).toBe(false);
  await act(async () => button('settings.common.actions.cancel').click());
  expect(field('password').value).toBe(''); expect(field('username').value).toBe('');
  expect(button('settings.common.actions.saveChanges').disabled).toBe(true);
});
