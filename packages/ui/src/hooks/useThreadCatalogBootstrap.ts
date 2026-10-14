import React from 'react';
import type { ThreadsAPI } from '@varin/application-client';
import { bindThreadStore, useThreadStore } from '@/stores/useThreadStore';
export function useThreadCatalogBootstrap(api: ThreadsAPI | undefined) {
  React.useEffect(() => {
    if (!api) { useThreadStore.setState({ catalogLoaded: false, catalogError: 'Conversation service unavailable' }); return; }
    return bindThreadStore(api);
  }, [api]);
}
