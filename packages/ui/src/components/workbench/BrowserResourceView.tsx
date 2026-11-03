import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { DesktopBrowserPane, type DesktopBrowserPaneProps } from './DesktopBrowserPane';
import { RemoteBrowserPane } from './RemoteBrowserPane';
const subscribe = (changed: () => void) => subscribeRuntimeEndpointChanged(changed);
export function BrowserResourceView(props: DesktopBrowserPaneProps) {
  const generation = React.useSyncExternalStore(subscribe, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return isDesktopLocalOriginActive() ? <DesktopBrowserPane key={generation} {...props} /> : <RemoteBrowserPane key={generation} {...props} />;
}
