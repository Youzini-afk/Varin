import React from 'react';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { EMPTY_ORGANIZATION_NAVIGATION, useSessionDisplayStore, type OrganizationNavigationPreference } from '@/stores/useSessionDisplayStore';

/** Display choices share the original preference owner and follow the stable Host identity. */
export function useOrganizationNavigation(view: string) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const preference = useSessionDisplayStore(state => state.organizationNavigationByHost[host]?.[view] ?? EMPTY_ORGANIZATION_NAVIGATION);
  const setPreference = useSessionDisplayStore(state => state.setOrganizationNavigation);
  const update = React.useCallback((patch: Partial<OrganizationNavigationPreference>) => setPreference(host, view, patch), [host, view, setPreference]);
  return [preference, update] as const;
}
