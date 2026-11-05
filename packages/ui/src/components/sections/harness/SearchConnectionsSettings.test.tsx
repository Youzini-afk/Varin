import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mergeHarnessSettings, parseHarnessWebSearchSettings, type HarnessSettingsInput } from '@varin/protocol';
import { patchHarnessSettings } from './harness-settings-state';
import { SearchConnectionsSettings } from './SearchConnectionsSettings';
const fixture = vi.hoisted(() => ({ fetch: vi.fn(), t: (key: string) => key }));
vi.mock('@varin/application-client', async importOriginal => ({ ...await importOriginal<object>(), runtimeFetch: fixture.fetch, getRuntimeKey: () => 'host-a' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.t }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: React.PropsWithChildren<{ value: string; onValueChange(value: string): void }>) => <select data-value={value} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null, SelectValue: () => null, SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SelectItem: ({ value, children }: React.PropsWithChildren<{ value: string }>) => <option value={value}>{children}</option>,
}));
vi.mock('@/components/ui/switch', () => ({ Switch: ({ checked, onCheckedChange, ...props }: { checked: boolean; onCheckedChange(value: boolean): void }) =>
  <button {...props} role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} /> }));
let root: Root, container: HTMLElement, latest: HarnessSettingsInput;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.getElementById('app')!; root = createRoot(container); fixture.fetch.mockReset();
  fixture.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith('/credential') ? { configured: false } : { available: true, capabilities: { domains: 'native', pagination: false } }), { headers: { 'Content-Type': 'application/json' } }));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(initial: HarnessSettingsInput = {}) {
  function Settings() {
    const [settings, setSettings] = React.useState(initial); latest = settings;
    return <SearchConnectionsSettings harness={mergeHarnessSettings(settings, {})} update={patch => setSettings(previous => patchHarnessSettings(previous, patch) as HarnessSettingsInput)} />;
  }
  await act(async () => root.render(<Settings />));
}
const buttons = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent === text);
async function click(text: string, index = 0) { await act(async () => buttons(text)[index]!.click()); }
const disclosures = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')];
async function toggle(index: number) { await act(async () => disclosures()[index]!.click()); }
const configuration = () => {
  const value = parseHarnessWebSearchSettings(latest.web?.search);
  if (!value?.connections) throw new Error('Expected custom search connections');
  return { ...value, connections: value.connections };
};
const initial = () => ({ web: { search: { connections: [
  { id: 'one', name: 'First', provider: 'exa' as const, enabled: true, credentialRef: 'first-account' },
  { id: 'two', name: 'Second', provider: 'exa' as const, enabled: true, credentialRef: 'second-account' },
], defaultConnectionId: 'one', fallbackConnectionIds: ['one', 'two'] } } });
test('adds same-provider connections with independent identities and leaves removal explicitly empty', async () => {
  await render(); await click('settings.webConnections.add'); await click('settings.webConnections.add');
  const saved = configuration(); expect(saved.connections).toHaveLength(2); expect(saved.connections[0]?.provider).toBe('exa');
  expect(saved.connections[0]?.id).not.toBe(saved.connections[1]?.id); expect(saved.connections[0]?.credentialRef).not.toBe(saved.connections[1]?.credentialRef);
  await click('settings.harness.rules.remove'); await click('settings.harness.rules.remove');
  expect(configuration()).toMatchObject({ connections: [], fallbackConnectionIds: [] }); expect(latest.web?.search).toBeDefined();
  await click('settings.webConnections.restoreDefault'); expect(latest.web?.search).toBeUndefined();
});
test('migrates legacy credentials on first edit and changes fallback order without resetting defaults', async () => {
  await render({ web: { search: { provider: 'exa', endpoint: 'https://proxy.example/search', credentialRef: 'original-ref' } } });
  await click('settings.webConnections.add');
  expect(configuration().connections[0]).toMatchObject({ id: 'configured-exa', credentialRef: 'original-ref', endpoint: 'https://proxy.example/search' });
  expect(latest.web?.search).not.toHaveProperty('provider');
  await act(async () => root.unmount()); root = createRoot(container); await render(initial());
  await toggle(1);
  await click('settings.webConnections.moveEarlier', 1); expect(configuration().fallbackConnectionIds).toEqual(['two', 'one']); expect(configuration().defaultConnectionId).toBe('one');
  await click('settings.harness.rules.remove'); expect(configuration().connections.map(connection => connection.id)).toEqual(['two']); expect(configuration().fallbackConnectionIds).toEqual(['two']); expect(configuration().defaultConnectionId).toBeUndefined();
});
test('writes each key to its exact saved connection rather than the shared provider', async () => {
  await render(initial()); await toggle(1); vi.useFakeTimers(); const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type=password]')];
  await act(async () => { inputs[1]!.value = 'second-key'; inputs[1]!.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await act(async () => vi.advanceTimersByTime(650));
  const write = fixture.fetch.mock.calls.find(call => call[1]?.method === 'PUT');
  expect(write?.[0]).toBe('/api/harness/web-search/connections/two/credential'); expect(JSON.parse(write?.[1].body)).toEqual({ apiKey: 'second-key' });
});
test('tests once while pending and discards late results after the connection is removed', async () => {
  let resolve!: (response: Response) => void; let testSignal: AbortSignal | undefined; const fallback = fixture.fetch.getMockImplementation()!;
  fixture.fetch.mockImplementation((url: string, init?: RequestInit) => { if (!url.endsWith('/test')) return fallback(url, init); testSignal = init?.signal ?? undefined; return new Promise<Response>(done => { resolve = done; }); });
  await render(initial()); await toggle(0); await click('settings.webConnections.test'); await click('settings.webConnections.testing');
  expect(fixture.fetch.mock.calls.filter(call => call[0].endsWith('/test'))).toHaveLength(1);
  await click('settings.harness.rules.remove'); expect(testSignal?.aborted).toBe(true);
  await act(async () => resolve(new Response(JSON.stringify({ checkedAt: 123, status: 'ok', resultCount: 99 }))));
  expect(container.textContent).not.toContain('99 settings.webConnections.results'); expect(configuration().connections.map(connection => connection.id)).toEqual(['two']);
});

test('starts saved connections collapsed, opens additions and preserves editing across reversible toggles', async () => {
  await render(initial());
  expect(disclosures().map(button => button.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
  const first = disclosures()[0]!;
  const panel = document.getElementById(first.getAttribute('aria-controls')!)!;
  expect(panel.hasAttribute('inert')).toBe(true);
  await toggle(0);
  expect(panel.hasAttribute('inert')).toBe(false);
  vi.useFakeTimers();
  const name = [...panel.querySelectorAll<HTMLInputElement>('input')].find(input => input.value === 'First')!;
  await act(async () => { name.value = 'Renamed'; name.dispatchEvent(new window.Event('input', { bubbles: true })); });
  const reads = fixture.fetch.mock.calls.length;
  await toggle(0); await toggle(0);
  expect([...panel.querySelectorAll('input')]).toContain(name);
  expect(name.value).toBe('Renamed');
  expect(fixture.fetch.mock.calls).toHaveLength(reads);
  await act(async () => vi.advanceTimersByTime(650));
  expect(configuration().connections[0]?.name).toBe('Renamed');
  await toggle(0);
  await click('settings.webConnections.add');
  expect(disclosures().map(button => button.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'true']);
  await toggle(2);
  expect(disclosures()[2]!.getAttribute('aria-expanded')).toBe('false');
  expect(configuration().connections).toHaveLength(3);
});
