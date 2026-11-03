import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { defaultVarinExtensionServiceRoutingDocument, serviceRoutingScopeKey, type VarinExtensionHostStateSnapshot } from '@varin/extension-contract';
import { I18nProvider } from '@/lib/i18n';

const f = vi.hoisted(() => ({ snapshot: null as VarinExtensionHostStateSnapshot | null, workspaceId: 'native-workspace-id',
  select: vi.fn(), inspect: vi.fn(), api: {} }));
vi.mock('@/lib/extensions/catalog-store', () => ({ useVarinExtensionCatalog: () => ({ snapshot: f.snapshot }), setVarinExtensionServiceRoute: (...args: unknown[]) => f.select(...args) }));
vi.mock('@/lib/extensions/workbench-workspace', () => ({ useWorkbenchWorkspaceId: () => f.workspaceId }));
vi.mock('@/lib/extensions/agent-driver-description', () => ({ readAgentDriverDescription: (...args: unknown[]) => f.inspect(...args) }));
vi.mock('@/lib/runtime-api/registry', () => ({ getRegisteredRuntimeAPIs: () => ({ extensions: f.api }) }));
vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const Choice = React.createContext<((value: string) => void) | undefined>(undefined);
  return {
    Select: ({ value, onValueChange, children }: { value: string; onValueChange(value: string): void; children: React.ReactNode }) =>
      <Choice.Provider value={onValueChange}><div data-choice={value}>{children}</div></Choice.Provider>,
    SelectTrigger: () => null, SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children, disabled }: { value: string; children: React.ReactNode; disabled?: boolean }) => {
      const change = React.useContext(Choice); return <button disabled={disabled} onClick={() => change?.(value)}>{children}</button>;
    },
  };
});
const { AgentDriverRoutingSection } = await import('./AgentDriverRoutingSection');
const key = 'example.parallel-driver:host:varin.agent.driver@1';
let root: Root, container: HTMLElement;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.workspaceId = 'native-workspace-id';
  f.snapshot = { catalog: { authoritative: true, hostId: 'host-original', extensions: [{ desired: { enabled: true }, manifest: {
    id: 'example.parallel-driver', displayName: 'Parallel Driver', version: '1', entrypoints: { host: { file: 'host.cjs' } },
    provides: { services: [{ id: 'varin.agent.driver', version: 1, multiple: true }] },
  } }] }, routing: { authoritative: true, document: defaultVarinExtensionServiceRoutingDocument() }, services: { providers: [] } } as unknown as VarinExtensionHostStateSnapshot;
  f.inspect.mockReset().mockResolvedValue({ identity: { name: 'parallel', version: '1' }, configuration: null,
    modelRoles: [], recovery: 'none', checkpointSchema: null });
  f.select.mockReset().mockImplementation(async (serviceId, version, scope, choice) => {
    const doc = f.snapshot!.routing.document;
    doc.rules = doc.rules.filter(rule => serviceRoutingScopeKey(rule.scope) !== serviceRoutingScopeKey(scope));
    if (choice !== null) doc.rules.push({ serviceId, version, scope, providerKeys: choice, allowFallback: false });
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<I18nProvider><AgentDriverRoutingSection /></I18nProvider>));
const click = (label: string) => act(async () => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  expect(button, label).toBeTruthy(); button!.click();
});

test('the only installed driver is selectable but not automatic; selecting uses native workspace identity and displays actual recovery', async () => {
  await render();
  expect(container.textContent).toContain('Effective selection: Varin default loop (Rust)');
  expect(f.inspect).not.toHaveBeenCalled();
  await click('Parallel Driver');
  expect(f.select).toHaveBeenCalledWith('varin.agent.driver', 1, { workspaceId: 'native-workspace-id' }, [key], 'host-original');
  expect(container.textContent).toContain('Effective selection: Parallel Driver');
  expect(container.textContent).toContain('No checkpoint recovery');
  expect(f.inspect.mock.calls[0]![1]).toMatchObject({ providerKey: key, hostId: 'host-original' });
});

test('explicit workspace builtin overrides user driver; removing the workspace override restores inheritance', async () => {
  f.snapshot!.routing.document.rules.push({ serviceId: 'varin.agent.driver', version: 1,
    scope: { userId: 'default' }, providerKeys: [key], allowFallback: false });
  await render(); expect(container.textContent).toContain('Effective selection: Parallel Driver');
  await click('Varin default loop (Rust)');
  expect(container.textContent).toContain('Effective selection: Varin default loop (Rust)');
  await click('Inherit (no override here)');
  expect(container.textContent).toContain('Effective selection: Parallel Driver');
  expect(f.select.mock.calls.at(-1)![3]).toBeNull();
});

test('an unavailable selected provider remains unavailable rather than silently displaying the builtin as effective', async () => {
  f.snapshot!.routing.document.rules.push({ serviceId: 'varin.agent.driver', version: 1,
    scope: { workspaceId: f.workspaceId }, providerKeys: ['missing:host:varin.agent.driver@1'], allowFallback: true });
  await render();
  expect(container.textContent).not.toContain('Effective selection: Varin default loop (Rust)');
  expect(container.textContent).toContain('missing:host:varin.agent.driver@1');
  expect(f.inspect).not.toHaveBeenCalled();
});
