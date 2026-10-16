import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';
import type { ModelChannel } from '@varin/application-client';
import type { VarinEvent } from '@/lib/varinEvents';

const runtime = vi.hoisted(() => ({ read: vi.fn(), mobile: false, showPicker: false, generation: 1,
  events: new Set<(event: VarinEvent) => void>(), willChange: new Set<() => void>(), changed: new Set<() => void>() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  createModelConnectionsHttpAPI: () => ({ read: runtime.read }),
  getRuntimeEndpointGeneration: () => runtime.generation,
  subscribeRuntimeEndpointWillChange: (listener: () => void) => { runtime.willChange.add(listener); return () => runtime.willChange.delete(listener); },
  subscribeRuntimeEndpointChanged: (listener: () => void) => { runtime.changed.add(listener); return () => runtime.changed.delete(listener); },
}));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: VarinEvent) => void) => { runtime.events.add(listener); return () => runtime.events.delete(listener); } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), getCurrentIntlLocale: () => 'zh-CN' }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: (select: (state: object) => unknown) => select({ currentDirectory: '/workspace' }),
}));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (select: (state: object) => unknown) => select({
    isMobile: runtime.mobile, hiddenModels: [], providerOrder: [],
    toggleFavoriteModel: vi.fn(), isFavoriteModel: vi.fn(), addRecentModel: vi.fn(),
  }),
}));
vi.mock('@/hooks/useModelLists', () => ({ useModelLists: () => ({ favoriteModelsList: [], recentModelsList: [] }) }));
vi.mock('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => <i data-icon={name} className={className} />,
}));
vi.mock('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => <i data-provider-logo /> }));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => runtime.showPicker ? <div>{children}</div> : null,
}));
vi.mock('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: ({ children }: React.PropsWithChildren) => runtime.showPicker ? <div>{children}</div> : null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));

let root: Root | undefined;
beforeEach(() => {
  useModelCatalogStore.setState({ channels: [], loaded: false, loading: false, error: null });
  runtime.read.mockReset();
  runtime.showPicker = false; runtime.mobile = false;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  useModelCatalogStore.setState({ channels: [], loaded: false, loading: false, error: null });
  vi.unstubAllGlobals();
});

describe('model catalog failures', () => {
  for (const mobile of [false, true]) {
    it(`stops loading on failure and retries from the ${mobile ? 'mobile' : 'desktop'} trigger`, async () => {
      runtime.mobile = mobile;
      let finish!: (value: { channels: [] }) => void;
      runtime.read.mockRejectedValueOnce(new Error('Invalid model role: unknownRole'))
        .mockImplementationOnce(() => new Promise<{ channels: [] }>((resolve) => { finish = resolve; }));
      const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
      vi.stubGlobal('window', window);
      vi.stubGlobal('document', window.document);
      vi.stubGlobal('HTMLElement', window.HTMLElement);
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      root = createRoot(window.document.getElementById('app')!);
      await act(async () => root!.render(<ModelSelector providerId="" modelId="" onChange={vi.fn()} />));
      const trigger = window.document.querySelector<HTMLButtonElement>('button')!;
      expect(trigger.textContent).toContain('common.unavailable');
      expect(trigger.title).toContain('Invalid model role: unknownRole');
      expect(trigger.disabled).toBeFalsy();
      expect(window.document.querySelector('[data-icon="loader-4"]')).toBeNull();
      expect(window.document.querySelector('[data-icon="error-warning"]')).not.toBeNull();
      await act(async () => trigger.click());
      expect(runtime.read).toHaveBeenCalledTimes(2);
      expect(trigger.disabled).toBeTruthy();
      expect(trigger.textContent).toContain('common.loading');
      await act(async () => finish({ channels: [] }));
      expect(trigger.disabled).toBeFalsy();
      expect(trigger.textContent).toContain('settings.agents.modelSelector.notSelected');
      expect(window.document.querySelector('[data-icon="loader-4"]')).toBeNull();
    });
  }

});

const catalog = (contextWindow: number): { channels: ModelChannel[] } => ({ channels: [{
  id: 'local', name: 'Local', type: 'openai-compatible', enabled: true, baseUrl: 'http://localhost/v1',
  authentication: { kind: 'none' }, parameters: {},
  models: [{ id: 'model', name: 'Model', enabled: true, operations: ['chat'], contextWindow }],
}] });
const mountPicker = async () => {
  runtime.showPicker = true;
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(window.document.getElementById('app')!);
  await renderPicker();
  return window.document;
};
const renderPicker = () => act(async () => root!.render(<ModelSelector providerId="local" modelId="model" onChange={vi.fn()} open tooltipsEnabled={false} />));
const emit = (event: VarinEvent) => { for (const listener of runtime.events) listener(event); };

describe('model catalog activation', () => {
  for (const mobile of [false, true]) {
    it(`refreshes saved capacity when the ${mobile ? 'mobile' : 'desktop'} composer returns from settings`, async () => {
      runtime.mobile = mobile;
      let saved = catalog(32768);
      runtime.read.mockImplementation(async () => structuredClone(saved));
      const document = await mountPicker();
      expect(document.body.textContent).toContain('3.3万');
      await act(async () => root!.render(null));
      expect(runtime.events.size).toBe(0);
      saved = catalog(200000);
      emit({ type: 'settings-changed', owner: 'agent-settings', scope: 'host', revision: 'saved', ids: ['model-channels'] });
      await renderPicker();
      expect(document.body.textContent).toContain('20万');
      expect(document.body.textContent).not.toContain('3.3万');
      expect(runtime.read).toHaveBeenCalledTimes(2);
    });
  }

  it('refreshes mounted pickers for saved model changes and stream reconnection', async () => {
    runtime.read.mockResolvedValueOnce(catalog(32768)).mockResolvedValueOnce(catalog(200000)).mockResolvedValueOnce(catalog(300000));
    const document = await mountPicker();
    await act(async () => emit({ type: 'settings-changed', owner: 'agent-settings', scope: 'host', revision: 'saved', ids: ['model-channels'] }));
    expect(document.body.textContent).toContain('20万');
    await act(async () => emit({ type: 'stream-ready' }));
    expect(document.body.textContent).toContain('30万');
  });

  it('reloads on Host changes and ignores a late result from the original Host', async () => {
    let finish!: (value: ReturnType<typeof catalog>) => void;
    runtime.read.mockResolvedValueOnce(catalog(32768))
      .mockImplementationOnce(() => new Promise<ReturnType<typeof catalog>>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(catalog(300000));
    const document = await mountPicker();
    await act(async () => emit({ type: 'settings-changed', owner: 'agent-settings', scope: 'host', revision: 'saved', ids: ['model-channels'] }));
    await act(async () => {
      for (const listener of runtime.willChange) listener();
      runtime.generation += 1;
      for (const listener of runtime.changed) listener();
    });
    expect(document.body.textContent).toContain('30万');
    await act(async () => finish(catalog(200000)));
    expect(document.body.textContent).toContain('30万');
    expect(document.body.textContent).not.toContain('20万');
  });
});
