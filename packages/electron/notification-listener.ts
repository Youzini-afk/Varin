// Both shells use the same authenticated SSE owner. Electron keeps its original
// HTTP/TLS transport; the managed native shell injects its Chromium transport.
import { NotificationListener as SharedNotificationListener, type NotificationListenerOptions, type NotificationLogger } from '../web/application-host/lib/platform/notification-listener.js';
export type { DesktopNotificationDetail, NotificationListenerOptions } from '../web/application-host/lib/platform/notification-listener.js';
let logger: NotificationLogger | undefined;
let loading: Promise<void> | undefined;
const fallback = (level: 'info' | 'warn' | 'error', values: unknown[]) => {
  loading ??= import('electron-log/main.js').then(module => { logger = module.default || module; }, () => {});
  (logger ?? console)[level](...values);
};
export class NotificationListener extends SharedNotificationListener {
  constructor(options: NotificationListenerOptions) {
    super({ ...options, logger: options.logger ?? { info: (...values) => fallback('info', values), warn: (...values) => fallback('warn', values), error: (...values) => fallback('error', values) } });
  }
}
