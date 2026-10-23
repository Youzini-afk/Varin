import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, test, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => 1, subscribeRuntimeEndpointChanged: () => () => {},
  createModelConnectionsHttpAPI: () => ({ readSettings: fixture.read, updateSettings: fixture.write }),
}));
vi.mock('@/lib/projectTrust', () => ({ getProjectTrustGeneration: () => 1, subscribeProjectTrustChanges: () => () => {} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/useModelCatalogStore', () => ({ useModelCatalogStore: (select: (value: unknown) => unknown) => select({ channels: [] }) }));
vi.mock('../agents/ModelSelector', () => ({ ModelSelector: ({ disabled, onChange }: { disabled: boolean; onChange(provider: string, model: string): void }) => <>
  <button disabled={disabled} onClick={() => onChange('provider', 'new')}>Choose model</button>
  <button disabled={disabled} onClick={() => onChange('', '')}>Inherit model</button>
</> }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ disabled, onValueChange }: { disabled: boolean; onValueChange(value: string): void }) => <button disabled={disabled} onClick={() => onValueChange('inherit')}>Inherit thinking</button>,
  SelectContent: () => null, SelectItem: () => null, SelectTrigger: () => null, SelectValue: () => null,
}));
vi.mock('../shared/SettingsSection', () => ({ SettingsFieldRow: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
import { ProjectDefaultModelField } from './ProjectDefaultModelField';
test('project defaults keep their owner and restore inheritance by removing overrides', async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.getElementById('root')!, root = createRoot(container);
  let snapshot = { global: { defaultProvider: 'global', defaultModel: 'base', defaultThinkingLevel: 'low' },
    project: { defaultProvider: 'project', defaultModel: 'old', defaultThinkingLevel: 'high' } as Record<string, string>,
    globalRevision: 'g', projectRevision: 'p0', projectTrusted: true };
  fixture.read.mockResolvedValue(snapshot);
  fixture.write.mockImplementation(async (input: { set: Record<string, string>; remove: string[] }) => {
    const project = { ...snapshot.project, ...input.set }; for (const key of input.remove) delete project[key];
    snapshot = { ...snapshot, project, projectRevision: 'p' + fixture.write.mock.calls.length }; return snapshot;
  });
  const click = (label: string) => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === label)!.click());
  try {
    await act(async () => root.render(<ProjectDefaultModelField directory="/selected-project" />));
    await click('Inherit thinking');
    expect(fixture.write).toHaveBeenLastCalledWith({ cwd: '/selected-project', scope: 'project', expectedRevision: 'p0', set: {}, remove: ['defaultThinkingLevel'] });
    await click('Choose model');
    expect(snapshot.project).toEqual({ defaultProvider: 'provider', defaultModel: 'new' });
    await click('Inherit model');
    expect(snapshot.project).toEqual({});
    expect(snapshot.global).toEqual({ defaultProvider: 'global', defaultModel: 'base', defaultThinkingLevel: 'low' });
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
