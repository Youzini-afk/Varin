import React from 'react';
import type { PluginCenterAPI } from '@varin/application-client';
import type { VarinExtensionUpdateCheck } from '@varin/extension-contract';
import { getVarinExtensionCatalogState } from '@/lib/extensions/catalog-store';

/** Update observations belong to the installation revision that was checked. */
export function usePluginUpdateChecks(api: PluginCenterAPI | undefined, revision: number | undefined, active: boolean, isCurrent: () => boolean) {
  const [state, setState] = React.useState<{ revision?: number; updates: VarinExtensionUpdateCheck[]; checking: boolean; error?: string }>({ updates: [], checking: false });
  const epoch = React.useRef(0);
  const mounted = React.useRef(false);
  const invalidate = React.useCallback(() => { epoch.current++; }, []);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; invalidate(); };
  }, [invalidate]);
  const check = React.useCallback(async (extensionId?: string) => {
    if (!api || revision === undefined || !mounted.current || !isCurrent()) return;
    const request = ++epoch.current;
    const current = () => mounted.current && isCurrent() && request === epoch.current
      && revision === getVarinExtensionCatalogState().snapshot?.catalog.revision;
    setState(previous => ({ revision, updates: previous.revision === revision ? previous.updates : [], checking: true }));
    try {
      const next = await api.checkUpdates(extensionId);
      if (current()) setState(previous => ({ revision, checking: false,
        updates: extensionId ? [...previous.updates.filter(item => item.extensionId !== extensionId), ...next] : next }));
    } catch (failure) {
      if (current()) setState(previous => ({ ...previous, checking: false, error: failure instanceof Error ? failure.message : String(failure) }));
    }
  }, [api, revision, isCurrent]);
  React.useEffect(() => {
    // Both navigation and catalog changes invalidate old pending completions.
    invalidate();
    setState(previous => ({ revision, updates: previous.revision === revision ? previous.updates : [], checking: false }));
    if (active) void check();
    return invalidate;
  }, [active, revision, check, invalidate]);
  return { updates: state.revision === revision ? state.updates : [],
    checking: state.revision === revision && state.checking,
    error: state.revision === revision ? state.error : undefined, check };
}
