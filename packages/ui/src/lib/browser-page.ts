import { isDesktopLocalOriginActive } from './desktop';
import { invokeDesktopCommand } from './desktopNative';

const ownedPrefix = 'browser:page:';
export function embeddedBrowserPageId(directory: string, tabId: string): string {
  return tabId.startsWith(ownedPrefix) ? tabId.slice(ownedPrefix.length) : `ui:${encodeURIComponent(directory.replace(/\\/g, '/'))}:${tabId}`;
}
export function closeEmbeddedBrowserPage(directory: string, tabId: string) {
  closeEmbeddedBrowserPageId(embeddedBrowserPageId(directory, tabId));
}
export function closeEmbeddedBrowserPageId(pageId: string) {
  if (!isDesktopLocalOriginActive()) return;
  void invokeDesktopCommand('desktop_browser_action', { pageId, action: { action: 'close' } }).catch(() => undefined);
}
