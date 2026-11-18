import React from 'react';

import type { RuntimeAPIs } from '@varin/application-client';
import { ApplicationLoadingScreen } from '@/components/ui/ApplicationLoadingScreen';

import type { DesktopBootView } from '@/lib/desktopBoot';

const App = React.lazy(async () => {
  const [appModule, extensionRuntime, workbenchRegistration, surfaceRuntime] = await Promise.all([
    import('@/App'),
    import('@/lib/extensions/managed-runtime'),
    import('@/workbenches/register-shells'),
    import('@/lib/extensions/surface-runtime'),
  ]);
  workbenchRegistration.registerWorkbenchShells(surfaceRuntime.varinSurfaceRuntime.surface);
  void extensionRuntime.startSurfaceExtensions().catch((error) => {
    console.error('[Varin Extensions] Managed Surface startup failed:', error);
  });
  return { default: appModule.default };
});

export const VarinApplication: React.FC<{ apis: RuntimeAPIs; bootView: Extract<DesktopBootView, { screen: 'main' }> | null }> = (props) => (
  <React.Suspense fallback={<ApplicationLoadingScreen />}>
    <App {...props} />
  </React.Suspense>
);
