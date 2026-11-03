import { prepareDesktopRenderer } from './desktop-bootstrap';
import type { RuntimeAPIs } from '@varin/application-client';
import '@varin/ui/styles/application';
import '@varin/ui/styles/fonts';

declare global {
  interface Window {
    __VARIN_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

await prepareDesktopRenderer();
const { createConfiguredWebAPIs } = await import('./runtimeConfig');
window.__VARIN_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@varin/ui/apps/renderElectronMiniChatApp')
  .then(({ renderElectronMiniChatApp }) => {
    renderElectronMiniChatApp(window.__VARIN_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
