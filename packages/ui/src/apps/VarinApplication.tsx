import React from 'react';

import type { RuntimeAPIs } from '@varin/application-client';
import { ApplicationLoadingScreen } from '@/components/ui/ApplicationLoadingScreen';

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

export const VarinApplication: React.FC<{ apis: RuntimeAPIs }> = ({ apis }) => (
  <React.Suspense fallback={<ApplicationLoadingScreen />}>
    <App apis={apis} />
  </React.Suspense>
);
