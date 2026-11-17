import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExternalAgentsAPI, ExternalAgentSettings, ThreadSourceTargets } from '@varin/application-client';
import { ExternalAgentsPage } from './ExternalAgentsPage';
import { externalAgentEn } from '@/lib/i18n/messages/external-agents';
import type { SourceResourceOwner } from '@varin/protocol';

const f = vi.hoisted(() => ({ host: 1, listeners: new Set<() => void>(), settings: undefined as ExternalAgentSettings | undefined,
  sources: { targets: [], unavailable: [] } as ThreadSourceTargets, installations: vi.fn<ExternalAgentsAPI['installations']>(), read: vi.fn<ExternalAgentsAPI['settings']>(), detect: vi.fn<ExternalAgentsAPI['detect']>(), configure: vi.fn<ExternalAgentsAPI['configure']>(), refresh: vi.fn(async () => {}) }));
vi.mock('@varin/application-client', () => ({
  getRuntimeEndpointGeneration: () => f.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { f.listeners.add(listener); return () => f.listeners.delete(listener); },
  createExternalAgentsHttpAPI: () => ({ settings: f.read, detect: f.detect, configure: f.configure, installations: f.installations, observeInstallations: async (listener: (value: unknown) => Promise<void>, signal: AbortSignal, owner?: SourceResourceOwner) => {
    let state = await f.installations({action:'state'}, signal, owner);
    while (!signal.aborted) { await listener(state); state = await f.installations({action:'watch',after:state.revision},signal,owner); }
  } }),
}));
vi.mock('@/lib/i18n', () => { const t = (key: string) => (externalAgentEn as Record<string, string>)[key] ?? key; return { useI18n: () => ({ t }) }; });
vi.mock('@/hooks/useRuntimeAPIs', () => { const threads = { sources: { list: async () => f.sources } }; return { useRuntimeAPIs: () => ({ threads }) }; });
vi.mock('@/stores/useExternalAgentStore', () => ({ useExternalAgents: () => f.settings,
  useExternalAgentStore: Object.assign(() => null, { getState: () => ({ refresh: f.refresh }) }) }));
vi.mock('@/lib/url', () => ({ openExternalUrl: vi.fn(async () => true) }));
vi.mock('@/components/thread/HarnessIcon', () => ({ HarnessIcon: () => null }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/sections/shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children, headerEnd, scope }: React.PropsWithChildren<{ headerEnd?: React.ReactNode; scope?: React.ReactNode }>) => <main>{scope}{headerEnd}{children}</main> }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SettingsFieldRow: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section> }));
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
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: React.PropsWithChildren) => children, motion: { div: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => <div className={className}>{children}</div> } }));
vi.mock('@/components/ui/switch', () => ({ Switch: ({ checked, onCheckedChange, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { checked: boolean; onCheckedChange(value: boolean): void }) => <button {...props} role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} /> }));
vi.mock('@/components/ui/dialog', () => { const Fragment = ({ children }: React.PropsWithChildren) => <>{children}</>; return { Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? children : null, DialogContent: Fragment, DialogHeader: Fragment, DialogTitle: Fragment, DialogDescription: Fragment }; });
vi.mock('@/components/ui/dropdown-menu', () => { const Fragment = ({ children }: React.PropsWithChildren) => <>{children}</>; return { DropdownMenu: Fragment, DropdownMenuTrigger: Fragment, DropdownMenuContent: Fragment, DropdownMenuItem: ({ children, onSelect, disabled }: React.PropsWithChildren<{ onSelect(): void; disabled?: boolean }>) => <button disabled={disabled} onClick={onSelect}>{children}</button> }; });
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); f.host++; f.sources = { targets: [], unavailable: [] };
  // Metadata is supplied by the Host, rather than a renderer-owned installation registry.
  f.settings = { revision: 7, defaultAgent: null, profiles: [
    { id: 'named', name: 'Named ACP', harness: 'acp', description: 'Host-provided description', platforms: ['linux', 'darwin'],
      launch: { command: '/host/bin/agent', args: ['--acp'] }, authentication: 'Run the original CLI login yourself.',
      compatibility: 'The installed release negotiates its actual capabilities.', installUrl: 'https://example.test/agent/setup' },
  ], agents: [
    { id: 'named', name: 'Named ACP', harness: 'acp', enabled: true, command: '/host/bin/agent', args: ['--acp'] },
    { id: 'custom', name: 'Custom ACP', harness: 'acp', enabled: false, command: 'custom', args: [] },
  ] };
  f.detect.mockImplementation(async id => ({ id, status: 'available', version: '1.2.3' }));
  f.read.mockImplementation(async () => f.settings!);
  f.configure.mockImplementation(async value => { f.settings = { ...f.settings!, ...value, revision: f.settings!.revision + 1 }; return f.settings; });
  f.installations.mockImplementation(async (input, signal) => input.action === 'watch' ? new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) : { revision: '1', operations: [] });
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<React.StrictMode><ExternalAgentsPage /></React.StrictMode>));
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
const openNamed = () => act(async () => container.querySelector<HTMLButtonElement>('.ea-row-main')!.click());
it('keeps missing automatic presets out of the main list and exposes enabled state in details', async () => {
  f.settings!.agents.push({ id: 'missing', name: 'Missing preset', harness: 'acp', command: 'missing', args: [], enabled: true, availability: 'auto' });
  f.detect.mockImplementation(async id => ({ id, status: id === 'missing' ? 'missing' : 'available', version: '1.2.3' }));
  await render();
  expect(container.textContent).toContain('1.2.3');
  expect(container.textContent).not.toContain('Missing preset');
  expect(f.configure).not.toHaveBeenCalled();
  await openNamed();
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  expect(container.textContent).not.toContain('Run the original CLI login yourself');
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(f.configure.mock.lastCall?.[0].agents[0]).toMatchObject({ enabled: false, availability: 'disabled', args: ['--acp'] });
});
it('uses connected devices without requiring projects and saves to the selected owner', async () => {
  const resourceOwner: SourceResourceOwner = { kind: 'managed_host', hostId: 'server', connectionId: 'pairing', endpointIdentity: 'endpoint' };
  f.sources.targets = [{ resourceOwner, label: 'Development server', capabilities: ['filesystem:read', 'filesystem:write', 'terminal:use', 'process:control'] }];
  await render();
  await act(async () => button('Development server').click());
  expect(f.read).toHaveBeenLastCalledWith(expect.any(AbortSignal), resourceOwner);
  expect(f.detect).toHaveBeenLastCalledWith('named', expect.any(AbortSignal), resourceOwner);
  await openNamed();
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(f.configure.mock.lastCall?.[3]).toEqual(resourceOwner);
});
it('discards an old Host detection when the runtime switches', async () => {
  let reject!: (error: Error) => void; let signal: AbortSignal | undefined;
  f.detect.mockImplementationOnce((_id, requestSignal) => { signal = requestSignal; return new Promise((_resolve, fail) => { reject = fail; }); });
  await render();
  await act(async () => { f.host++; f.listeners.forEach(listener => listener()); });
  await act(async () => reject(new Error('Old Host failure')));
  expect(signal?.aborted).toBe(true);
  expect(container.textContent).not.toContain('Old Host failure');
  expect(container.textContent).toContain('1.2.3');
});
it('uses cached model options and clears thinking belonging to the previous model', async () => {
  f.settings!.agents[0]!.defaults = { model: 'reasoner', thinking: 'high', mode: 'plan' };
  f.settings!.capabilityCache = { named: { cachedAt: 1000, capabilities: { resume: true, images: false, steering: false,
    models: [{ id: 'reasoner', name: 'Reasoner', thinkingLevels: ['low', 'high'] }, { id: 'fast', name: 'Fast' }], modes: [{ id: 'plan', name: 'Plan' }] } } };
  await render(); await openNamed();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-option="value:fast"]')!.click());
  expect(f.configure.mock.lastCall?.[0].agents[0]?.defaults).toEqual({ model: 'fast', mode: 'plan' });
});
it('keeps a retired default visible and clearable without inventing model choices', async () => {
  f.settings!.agents[0]!.defaults = { model: 'retired' };
  await render(); await openNamed();
  expect(container.textContent).toContain('retired');
  expect(container.querySelector<HTMLButtonElement>('[data-option="value:retired"]')?.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-option="inherit"]')!.click());
  expect(f.configure.mock.lastCall?.[0].agents[0]?.defaults).toBeUndefined();
});
