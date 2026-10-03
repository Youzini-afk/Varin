import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';
import { usePiProviderStore } from '@/stores/usePiProviderStore';

const runtime = vi.hoisted(() => ({ providers: vi.fn(), models: vi.fn(), config: vi.fn(), mobile: false }));
vi.mock('@/lib/pi-runtime/providers', () => ({
  listPiProviders: runtime.providers, listPiModels: runtime.models, getPiProviderConfig: runtime.config,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
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
  DropdownMenuContent: () => null,
}));
vi.mock('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: () => null }));
vi.mock('@/components/model-picker/ModelPickerList', () => ({ ModelPickerList: () => null }));

let root: Root | undefined;
beforeEach(() => {
  usePiProviderStore.getState().reset();
  runtime.providers.mockReset();
  runtime.models.mockReset().mockResolvedValue([]);
  runtime.config.mockReset();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  usePiProviderStore.getState().reset();
  vi.unstubAllGlobals();
});

describe('model catalog failures', () => {
  for (const mobile of [false, true]) {
    it(`stops loading on failure and retries from the ${mobile ? 'mobile' : 'desktop'} trigger`, async () => {
      runtime.mobile = mobile;
      let finish!: (value: []) => void;
      runtime.providers.mockRejectedValueOnce(new Error('Invalid model role: unknownRole'))
        .mockImplementationOnce(() => new Promise<[]>((resolve) => { finish = resolve; }));
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
      expect(runtime.providers).toHaveBeenCalledTimes(2);
      expect(trigger.disabled).toBeTruthy();
      expect(trigger.textContent).toContain('common.loading');
      await act(async () => finish([]));
      expect(trigger.disabled).toBeFalsy();
      expect(trigger.textContent).toContain('settings.agents.modelSelector.notSelected');
      expect(window.document.querySelector('[data-icon="loader-4"]')).toBeNull();
    });
  }

  it('shares a pending catalog load instead of treating the previous directory as loaded', async () => {
    runtime.providers.mockResolvedValueOnce([]);
    await usePiProviderStore.getState().load('/first');
    let finish!: (value: []) => void;
    runtime.providers.mockImplementationOnce(() => new Promise<[]>((resolve) => { finish = resolve; }));
    const first = usePiProviderStore.getState().load('/second');
    const repeated = usePiProviderStore.getState().load('/second');
    expect(usePiProviderStore.getState()).toMatchObject({ cwd: '/second', loaded: false, isLoading: true });
    finish([]);
    await Promise.all([first, repeated]);
    expect(runtime.providers).toHaveBeenCalledTimes(2);
    expect(usePiProviderStore.getState()).toMatchObject({ cwd: '/second', loaded: true, isLoading: false });
  });
});
