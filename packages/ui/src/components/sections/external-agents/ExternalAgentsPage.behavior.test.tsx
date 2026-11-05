import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExternalAgentsAPI, ExternalAgentSettings } from '@varin/application-client';
import { ExternalAgentsPage } from './ExternalAgentsPage';
import { externalAgentEn } from '@/lib/i18n/messages/external-agents';
import { openExternalUrl } from '@/lib/url';

const f = vi.hoisted(() => ({ host: 1, listeners: new Set<() => void>(), settings: undefined as ExternalAgentSettings | undefined,
  detect: vi.fn<ExternalAgentsAPI['detect']>(), configure: vi.fn<ExternalAgentsAPI['configure']>(), refresh: vi.fn(async () => {}) }));
vi.mock('@varin/application-client', () => ({
  getRuntimeEndpointGeneration: () => f.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { f.listeners.add(listener); return () => f.listeners.delete(listener); },
  createExternalAgentsHttpAPI: () => ({ detect: f.detect, configure: f.configure }),
}));
vi.mock('@/lib/i18n', () => { const t = (key: string) => (externalAgentEn as Record<string, string>)[key] ?? key; return { useI18n: () => ({ t }) }; });
vi.mock('@/stores/useExternalAgentStore', () => ({ useExternalAgents: () => f.settings,
  useExternalAgentStore: Object.assign(() => null, { getState: () => ({ refresh: f.refresh }) }) }));
vi.mock('@/lib/url', () => ({ openExternalUrl: vi.fn(async () => true) }));
vi.mock('@/components/thread/HarnessIcon', () => ({ HarnessIcon: () => null }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/sections/shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children }: React.PropsWithChildren) => <main>{children}</main> }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SettingsFieldRow: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('@/components/ui/select', async () => {
  const { createContext, useContext } = await import('react');
  const Selection = createContext<{ disabled?: boolean; onValueChange?(value: string): void }>({});
  return {
    Select: ({ children, disabled, onValueChange }: React.PropsWithChildren<{ disabled?: boolean; onValueChange(value: string): void }>) =>
      <Selection.Provider value={{ disabled, onValueChange }}>{children}</Selection.Provider>,
    SelectTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props}>{children}</button>,
    SelectContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
    SelectValue: () => null,
    SelectItem: ({ children, value, disabled }: React.PropsWithChildren<{ value: string; disabled?: boolean }>) => {
      const select = useContext(Selection);
      return <button type="button" data-option={value} disabled={disabled || select.disabled} onClick={() => select.onValueChange?.(value)}>{children}</button>;
    },
  };
});
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/input', () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> }));
vi.mock('@/components/ui/switch', () => ({ Switch: ({ checked, disabled, onCheckedChange, ...props }: { checked: boolean; disabled: boolean; onCheckedChange(value: boolean): void; 'aria-label': string }) =>
  <button {...props} disabled={disabled} role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} /> }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); f.host++;
  // Metadata is supplied by the Host, rather than a renderer-owned installation registry.
  f.settings = { revision: 7, defaultAgent: null, profiles: [
    { id: 'named', name: 'Named ACP', harness: 'acp', description: 'Host-provided description', platforms: ['linux', 'darwin'],
      launch: { command: '/host/bin/agent', args: ['--acp'] }, authentication: 'Run the original CLI login yourself.',
      compatibility: 'The installed release negotiates its actual capabilities.', installUrl: 'https://example.test/agent/setup' },
  ], agents: [
    { id: 'named', name: 'Named ACP', harness: 'acp', enabled: false, command: '/host/bin/agent', args: ['--acp'] },
    { id: 'custom', name: 'Custom ACP', harness: 'acp', enabled: false, command: 'custom', args: [] },
  ] };
  f.detect.mockImplementation(async id => ({ id, status: 'available', version: '1.2.3' }));
  f.configure.mockImplementation(async value => ({ ...f.settings!, ...value, revision: 8 }));
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<ExternalAgentsPage />));
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
it('shows Host profile guidance and installation-only detection without auto login/install or removing a built-in profile', async () => {
  await render();
  expect(container.textContent).toContain('Installed (version detected) · 1.2.3');
  expect(container.textContent).toContain('does not verify login, protocol compatibility, or model access');
  const named = [...container.querySelectorAll('section')].find(node => node.textContent?.includes('Host-provided description'))!;
  expect(named.textContent).toContain('linux · darwin'); expect(named.textContent).toContain('/host/bin/agent ["--acp"]');
  expect(named.textContent).toContain('Run the original CLI login yourself.'); expect(named.textContent).toContain('negotiates its actual capabilities');
  expect(named.textContent).not.toContain('Remove connection configuration');
  expect(container.textContent?.match(/Remove connection configuration/g)).toHaveLength(1);
  expect(f.configure).not.toHaveBeenCalled(); expect(openExternalUrl).not.toHaveBeenCalled();
  await act(async () => button('Installation and setup guide').click());
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.test/agent/setup');
});
it('toggles a built-in configuration without changing launch arguments or inventing authentication status', async () => {
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Named ACP · Enable in Varin"]')!.click());
  expect(f.configure).toHaveBeenCalledWith({ agents: [{ ...f.settings!.agents[0], enabled: true }, f.settings!.agents[1]], defaultAgent: null }, 7, expect.any(String));
  expect(container.textContent).not.toContain('Authenticated');
});
it('discards old Host detection results and aborts the original observation when the Host changes', async () => {
  let finish!: () => void;
  f.detect.mockImplementationOnce(id => new Promise(resolve => { finish = () => resolve({ id, status: 'failed', message: 'Old Host failure' }); }));
  await render(); const originalSignal = f.detect.mock.calls[0]![1];
  await act(async () => { f.host++; f.listeners.forEach(listener => listener()); });
  await act(async () => finish());
  expect(originalSignal?.aborted).toBe(true); expect(container.textContent).not.toContain('Old Host failure');
  expect(container.textContent).toContain('Installed (version detected)');
});

function addCatalogue() {
  f.settings!.capabilityCache = { named: { cachedAt: 1000, agentVersion: '1.2.3', capabilities: {
    resume: true, images: false, files: 'paths', steering: false,
    models: [{ id: 'reasoner', name: 'Reasoner', thinkingLevels: ['low', 'high'] }, { id: 'fast', name: 'Fast' }],
    current: { model: 'reasoner', thinking: 'low', mode: 'default' },
    modes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }],
  } } };
}
const namedRow = () => [...container.querySelectorAll('section')].find(node => node.textContent?.includes('Host-provided description'))!;
const selectOption = async (value: string) => act(async () => namedRow().querySelector<HTMLButtonElement>(`[data-option="value:${value}"]`)!.click());
const saveNamed = async () => act(async () => namedRow().querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));

it('offers only cached Host defaults and persists explicit choices on Save, without a connection or model request', async () => {
  addCatalogue();
  await render();
  expect(namedRow().textContent).toContain('Options from the last negotiated catalogue · 1.2.3');
  await selectOption('reasoner'); await selectOption('high'); await selectOption('plan');
  expect(f.configure).not.toHaveBeenCalled();
  await saveNamed();
  expect(f.configure).toHaveBeenCalledWith({ agents: [
    { ...f.settings!.agents[0], defaults: { model: 'reasoner', thinking: 'high', mode: 'plan' } }, f.settings!.agents[1],
  ], defaultAgent: null }, 7, expect.any(String));
  expect(f.detect).toHaveBeenCalledTimes(2);
});

it('clears model-specific thinking and preserves unsaved defaults through a metadata refresh', async () => {
  addCatalogue();
  f.settings!.agents[0]!.defaults = { model: 'reasoner', thinking: 'high', mode: 'plan' };
  await render(); await selectOption('fast');
  f.settings = { ...f.settings!, agents: f.settings!.agents.map(agent => ({ ...agent })),
    capabilityCache: { named: { ...f.settings!.capabilityCache!.named!, cachedAt: 2000 } } };
  await render(); await saveNamed();
  expect(f.configure.mock.calls[0]![0].agents[0]!.defaults).toEqual({ model: 'fast', mode: 'plan' });
});

it('keeps an unavailable saved default visible and clearable without inventing candidates', async () => {
  f.settings!.agents[0]!.defaults = { model: 'retired' };
  await render();
  expect(namedRow().textContent).toContain('Settings do not start a connection');
  expect(namedRow().textContent).toContain('retired · Not reported by Agent');
  expect(namedRow().querySelector<HTMLButtonElement>('[data-option="value:retired"]')!.disabled).toBe(true);
  await act(async () => namedRow().querySelector<HTMLButtonElement>('[data-option="inherit"]')!.click());
  await saveNamed();
  expect(f.configure.mock.calls[0]![0].agents[0]).not.toHaveProperty('defaults');
});
