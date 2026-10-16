import React from 'react';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { RuntimeEventSource, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';
import type { NotificationPayload } from '@varin/application-client';

const NOTIFICATION_STREAM_PATH = '/api/notifications/stream';

const isFocused = () => {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
};

const toNotificationPayload = (value: unknown): NotificationPayload | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const properties = record.properties && typeof record.properties === 'object'
    ? record.properties as Record<string, unknown>
    : null;
  if (record.type !== 'varin:notification' || !properties) return null;
  return {
    title: typeof properties.title === 'string' ? properties.title : undefined,
    body: typeof properties.body === 'string' ? properties.body : undefined,
    tag: typeof properties.tag === 'string' ? properties.tag : undefined,
  };
};

export const useWebNotificationStream = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;

  React.useEffect(() => {
    if (!enabled || isDesktopShell() || !isWebRuntime() || typeof window === 'undefined') {
      return;
    }

    let source: RuntimeEventSource;
    const onmessage = (event: MessageEvent<string>) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }

      const settings = useUIStore.getState();
      if (!settings.nativeNotificationsEnabled) return;
      if (settings.notificationMode !== 'always' && isFocused()) return;

      const payload = toNotificationPayload(data);
      if (!payload) return;

      const apis = getRegisteredRuntimeAPIs();
      void apis?.notifications?.notifyAgentCompletion(payload);
    };

    const connect = () => {
      source?.close();
      source = new RuntimeEventSource(NOTIFICATION_STREAM_PATH);
      source.onmessage = onmessage;
    };
    connect();
    const unsubscribe = subscribeRuntimeEndpointChanged(connect);
    return () => {
      unsubscribe();
      source.close();
    };
  }, [enabled]);
};
