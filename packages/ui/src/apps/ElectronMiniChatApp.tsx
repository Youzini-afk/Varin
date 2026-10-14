import React from 'react';
import type { RuntimeAPIs } from '@varin/application-client';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { subscribeDefaultDirectoryToRuntimeChanges } from '@/lib/directoryPersistence';
import { dismissInitialSplash } from '@/lib/splash';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { MiniChatLayout } from '@/components/mini-chat/MiniChatLayout';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useThreadCatalogBootstrap } from '@/hooks/useThreadCatalogBootstrap';
import { useThreadStore } from '@/stores/useThreadStore';
import { useAppFontEffects } from './useAppFontEffects';
import { useMiniChatKeyboardShortcuts } from '@/hooks/useMiniChatKeyboardShortcuts';
import { openThreadFromNavigation, startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';

export function ElectronMiniChatApp({ apis }: { apis: RuntimeAPIs }) {
  const config = React.useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return { mode: params.get('mode'), threadId: params.get('threadId'), branchId: params.get('branchId'), directory: params.get('directory') };
  }, []);
  useThreadCatalogBootstrap(apis.threads);
  const loaded = useThreadStore(state => state.catalogLoaded);
  const catalogError = useThreadStore(state => state.catalogError);
  React.useEffect(() => { if (catalogError) dismissInitialSplash(); }, [catalogError]);
  const [error, setError] = React.useState<string>();
  const initialized = React.useRef(false);
  React.useEffect(() => { registerRuntimeAPIs(apis); return () => registerRuntimeAPIs(null); }, [apis]);
  React.useEffect(() => subscribeDefaultDirectoryToRuntimeChanges(apis), [apis]);
  React.useEffect(() => {
    if (!loaded || initialized.current) return;
    initialized.current = true;
    if (config.mode === 'thread' && (!config.threadId || !config.branchId)) { setError('Thread and branch ids are required'); dismissInitialSplash(); return; }
    const open = config.threadId && config.branchId
      ? openThreadFromNavigation({ threadId: config.threadId, branchId: config.branchId, directory: config.directory })
      : startThreadFromNavigation({ directory: config.directory });
    void open.catch(error => setError(error instanceof Error ? error.message : String(error))).finally(dismissInitialSplash);
  }, [loaded, config]);
  useAppFontEffects(); useMiniChatKeyboardShortcuts(); useWindowTitle();
  return <ErrorBoundary><RuntimeAPIProvider apis={apis}><TooltipProvider delayDuration={300} skipDelayDuration={150}>
    <div className="h-full bg-background text-foreground"><MiniChatLayout unavailable={error ?? catalogError ?? undefined} /><Toaster /></div>
  </TooltipProvider></RuntimeAPIProvider></ErrorBoundary>;
}
