import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@varin/application-client';
import type { HostedSurface } from '@varin/ui/lib/runtimeSurface';
import '@varin/ui/styles/application';
import '@varin/ui/styles/fonts';

declare global {
  interface Window {
    __VARIN_RUNTIME_APIS__?: RuntimeAPIs;
    __VARIN_SURFACE__?: HostedSurface;
  }
}

window.__VARIN_SURFACE__ = 'mobile';
window.__VARIN_RUNTIME_APIS__ = createConfiguredWebAPIs();

void Promise.all([
  import('@varin/ui/apps/renderMobileApp'),
  import('@varin/ui/workbenches/register-shells'),
]).then(([{ renderMobileApp }, { registerWorkbenchShells }]) => {
  registerWorkbenchShells('mobile');
  renderMobileApp(window.__VARIN_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
});
