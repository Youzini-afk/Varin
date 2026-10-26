import React from 'react';
import { getRuntimeKey } from '@varin/application-client';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from '@/components/ui/context-menu';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getDirectoryForFilePath } from '@/lib/path-utils';
import { resolveTextDocumentIdentity } from '@/lib/documents/workspace-text';
import { isDesktopShell, isDesktopLocalOriginActive, openDesktopFileInApp, openDesktopPath, revealDesktopPath } from '@/lib/desktop';
import { useOpenInAppsStore, type OpenInAppOption } from '@/stores/useOpenInAppsStore';
import { AppIcon } from '@/components/desktop/OpenInAppButton';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { ChatFileResource, ChatFileTarget } from './chatFileTargets';

export function ChatFileMenu({ target }: { target: ChatFileTarget }) {
  const { t } = useI18n();
  const { documents, files } = useRuntimeAPIs();
  const availableApps = useOpenInAppsStore(state => state.availableApps);
  const selectedAppId = useOpenInAppsStore(state => state.selectedAppId);
  const initialize = useOpenInAppsStore(state => state.initialize);
  const local = isDesktopShell() && isDesktopLocalOriginActive();
  React.useEffect(() => { if (local) initialize(); }, [initialize, local]);
  const editors = availableApps.filter(app => !['finder', 'terminal', 'iterm2', 'ghostty'].includes(app.id));
  const preferred = editors.find(app => app.id === selectedAppId) ?? editors.find(app => app.id === 'vscode') ?? editors[0];
  const assertCurrent = () => { if (target.runtimeKey !== getRuntimeKey()) throw new DOMException('Host changed', 'AbortError'); };
  const resolve = async (): Promise<ChatFileResource> => {
    assertCurrent();
    const resource = target.resolve ? await target.resolve() : { path: target.path, directory: getDirectoryForFilePath(target.directory, target.path) };
    assertCurrent(); return resource;
  };
  const run = (action: () => void | Promise<void>) => {
    void Promise.resolve().then(() => { assertCurrent(); return action(); }).catch(error => {
      if (target.runtimeKey === getRuntimeKey() && !(error instanceof DOMException && error.name === 'AbortError')) toast.error(error instanceof Error ? error.message : String(error));
    });
  };
  const copy = async (text: string) => {
    assertCurrent(); const result = await copyTextToClipboard(text);
    if (!result.ok) throw new Error(result.error);
  };
  const openExternal = async (app?: OpenInAppOption) => {
    const file = await resolve();
    if (!(app ? await openDesktopFileInApp(file.path, app.id, app.appName) : await openDesktopPath(file.path))) throw new Error(t('chat.context.fileActionFailed'));
  };
  const copyContent = async () => {
    const file = await resolve();
    const resource = file.resource ?? await resolveTextDocumentIdentity(documents, file.directory, file.path);
    assertCurrent(); const result = await documents.read(resource); assertCurrent();
    if (result.status === 'missing') throw new Error(t('chat.context.fileMissing'));
    if (result.status !== 'ready') throw new Error(t('chat.context.fileNotText'));
    await copy(result.content);
  };
  const inset = 'pl-8';
  return <>
    <ContextMenuItem className={inset} onClick={() => run(target.open)}>{t('chat.context.openFile')}</ContextMenuItem>
    {local && preferred && <ContextMenuItem onClick={() => run(() => openExternal(preferred))}>
      <AppIcon label={preferred.label} iconDataUrl={preferred.iconDataUrl} />{t('openInApp.actions.openInAria', { app: preferred.label })}
    </ContextMenuItem>}
    {local && <ContextMenuSub>
      <ContextMenuSubTrigger className={inset}>{t('chat.context.openWith')}</ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-48">
        <ContextMenuItem onClick={() => run(() => openExternal())}><Icon name="external-link" className="size-4" />{t('chat.context.systemDefault')}</ContextMenuItem>
        {editors.length > 0 && <ContextMenuSeparator />}
        {editors.map(app => <ContextMenuItem key={app.id} onClick={() => run(() => openExternal(app))}>
          <AppIcon label={app.label} iconDataUrl={app.iconDataUrl} />{app.label}
        </ContextMenuItem>)}
      </ContextMenuSubContent>
    </ContextMenuSub>}
    <ContextMenuSeparator />
    {files.downloadFile && <ContextMenuItem className={inset} onClick={() => run(async () => {
      const file = await resolve(); await files.downloadFile!(file.path, { directory: file.directory });
    })}>{t('chat.context.saveFileAs')}</ContextMenuItem>}
    <ContextMenuItem className={inset} onClick={() => run(async () => {
      let path = target.path;
      try { path = (await resolve()).path; } catch { /* A displayed path can still be copied if its source no longer exists. */ }
      await copy(path);
    })}>{t('chat.context.copyPath')}</ContextMenuItem>
    <ContextMenuItem className={inset} onClick={() => run(copyContent)}>{t('chat.context.copyFileContent')}</ContextMenuItem>
    {local && <ContextMenuItem className={inset} onClick={() => run(async () => {
      const file = await resolve(); if (!await revealDesktopPath(file.path)) throw new Error(t('chat.context.fileActionFailed'));
    })}>{t(window.__VARIN_PLATFORM__ === 'darwin' ? 'common.revealPath.finder' : window.__VARIN_PLATFORM__ === 'win32' ? 'common.revealPath.fileExplorer' : 'common.revealPath.fileManager')}</ContextMenuItem>}
  </>;
}
