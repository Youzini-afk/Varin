import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';

const runtime = vi.hoisted(() => ({ read: vi.fn(), mobile: false }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createModelConnectionsHttpAPI: () => ({ read: runtime.read }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
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
  useModelCatalogStore.setState({ channels: [], loaded: false, loading: false, error: null });
  runtime.read.mockReset();
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
