import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ThreadIdentity, type ThreadSource, type ThreadDraftSkillOptions, type ThreadsAPI } from '@varin/application-client';
import type { Attachment, FamilyMember } from '@varin/protocol';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { getResolvedWorkbenchWorkspaceId, subscribeWorkbenchWorkspace } from '@/lib/extensions/workbench-workspace';
import { useEditorWorkbench } from '@/lib/workbench/editors/hooks';
import { activeEditorTab, listOpenResourceIds } from '@/lib/workbench/editors/groups';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { Icon } from '@/components/icon/Icon';
import { ChildState } from '@/components/conversation/childPresentation';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { useSourceFileCandidates } from './useSourceFileCandidates';
import { useI18n } from '@/lib/i18n';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { ComposerMenu, type ComposerMenuHandle, type ComposerMenuItem } from './composer/ComposerMenu';

export type FileMentionHandle = ComposerMenuHandle;
export interface ComposerAttachmentCandidate { id: string; name: string; attachment?: Attachment; fileId?: string }
type FileInfo = { path: string; relativePath: string; name: string; directory?: boolean };
export const FileMentionAutocomplete = React.forwardRef<FileMentionHandle, {
  source?: ThreadSource; pendingSource?: ThreadDraftSkillOptions['source']; searchQuery: string; workspacePath?: string; api?: ThreadsAPI; identity?: ThreadIdentity;
  attachments?: readonly ComposerAttachmentCandidate[]; fileSelectionDisabled?: string;
  onFileSelect(file: FileInfo): void; onThreadSelect?(identity: ThreadIdentity, name: string): void;
  onAttachmentSelect?(attachment: ComposerAttachmentCandidate): void;
  onClose(): void; menuId?: string; onActive?(id?: string): void;
}>(({ searchQuery, workspacePath, api, identity, source, pendingSource, attachments = [], fileSelectionDisabled, onFileSelect, onThreadSelect, onAttachmentSelect, onClose, menuId = 'composer-references', onActive }, ref) => {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const scope = JSON.stringify([host, identity?.threadId, identity?.branchId, source, pendingSource, workspacePath]);
  const workspaceId = React.useSyncExternalStore(subscribeWorkbenchWorkspace, () => workspacePath ? getResolvedWorkbenchWorkspaceId(workspacePath) : undefined, () => undefined);
  const workbench = useEditorWorkbench(workspaceId);
  const recentFiles: FileInfo[] = React.useMemo(() => {
    if (!workspacePath || !workbench) return [];
    const active = activeEditorTab(workbench);
    const ids = [...new Set([...(active ? [active.resourceId] : []), ...listOpenResourceIds(workbench.tree).slice().reverse()])];
    return ids.flatMap(id => {
      const filePath = workspacePathFromResourceId(workspacePath, id);
      if (!filePath) return [];
      const relativePath = filePath.slice(workspacePath.replace(/[\\/]+$/, '').length + 1);
      if (!relativePath.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase())) return [];
      return [{ path: relativePath, name: filePath.split(/[\\/]/).at(-1) ?? filePath, relativePath }];
    });
  }, [workspacePath, workbench, searchQuery]);
  const query = useDebouncedValue(searchQuery, 150);
  const [fileRetry, refreshFiles] = React.useReducer(value => value + 1, 0);
  const [directoryRetry, refreshDirectories] = React.useReducer(value => value + 1, 0);
  const [retry, refreshThreads] = React.useReducer(value => value + 1, 0);
  const files = useSourceFileCandidates({ api, identity, source, pendingSource, scope, query, requestedQuery: searchQuery, type: 'file', revision: fileRetry });
  const directories = useSourceFileCandidates({ api, identity, source, pendingSource, scope, query, requestedQuery: searchQuery, type: 'directory', revision: directoryRetry });
  const [threads, setThreads] = React.useState<{ scope: string; query: string; rows: FamilyMember[]; loading: boolean; error?: string; cursor?: string | null }>();
  const [cursor, setCursor] = React.useState<string>();
  React.useEffect(() => { setCursor(undefined); }, [searchQuery, scope]);
  React.useEffect(() => {
    if (!api?.family || !identity || query !== searchQuery) return;
    const controller = new AbortController();
    setThreads(previous => ({ scope, query, rows: previous?.scope === scope && previous.query === query ? previous.rows : [], loading: true }));
    void api.family.list(identity, { query, includeSelf: true, limit: 50, ...(cursor ? { cursor } : {}) }, controller.signal).then(page => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      setThreads(previous => ({ scope, query, loading: false, cursor: page.nextCursor,
        rows: [...new Map([...(cursor && previous?.scope === scope && previous.query === query ? previous.rows : []), ...page.members].map(item => [item.threadId, item])).values()] }));
    }, cause => { if (!controller.signal.aborted) setThreads(previous => ({ scope, query, rows: previous?.scope === scope && previous.query === query ? previous.rows : [], loading: false, error: cause instanceof Error ? cause.message : String(cause) })); });
    return () => controller.abort();
  }, [api, identity, scope, query, searchQuery, cursor, retry, host]);
  const visibleThreads = threads?.scope === scope && threads.query === searchQuery ? threads : undefined;
  const choices = new Map<string, () => void>();
  const items: ComposerMenuItem[] = [];
  for (const attachment of attachments.filter(item => (item.attachment || item.fileId) && item.name.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase()))) {
    const id = `attachment:${attachment.id}`;
    choices.set(id, () => onAttachmentSelect?.(attachment));
    items.push({ id, group: t('composer.group.attachments'), label: attachment.name, icon: <Icon name="attachment-2" className="size-4" /> });
  }
  const rank = (name: string) => name.toLocaleLowerCase() === searchQuery.toLocaleLowerCase() ? 0 : name.toLocaleLowerCase().startsWith(searchQuery.toLocaleLowerCase()) ? 1 : 2;
  const allFiles: FileInfo[] = [...recentFiles, ...files.rows, ...directories.rows.map(item => ({ ...item, directory: true }))];
  const fileRows = [...new Map(allFiles.map(file => [`${Boolean(file.directory)}:${file.path}`, file])).values()].sort((a, b) => rank(a.name) - rank(b.name));
  for (const directory of [false, true]) for (const file of fileRows.filter(item => Boolean(item.directory) === directory)) {
    const id = `${directory ? 'directory' : 'file'}:${file.path}`;
    choices.set(id, () => { if (!fileSelectionDisabled) onFileSelect(file); });
    items.push({ id, group: t(directory ? 'composer.group.directories' : 'composer.group.files'), label: file.name, description: file.relativePath, disabled: fileSelectionDisabled,
      source: workspacePath, icon: directory ? <Icon name="folder" className="size-4" /> : <FileTypeIcon filePath={file.path} className="size-4" /> });
  }
  for (const member of visibleThreads?.rows ?? []) for (const branch of member.branches) {
    const id = `thread:${member.threadId}:${branch.branchId}`;
    const name = member.name || member.agentId || member.threadId;
    choices.set(id, () => onThreadSelect?.({ runtime: 'agent', threadId: member.threadId, branchId: branch.branchId }, name));
    items.push({ id, group: t('composer.group.threads'), label: name, description: `${member.task ?? ''} · ${branch.branchId}${member.parentThreadId ? ` · ${member.parentThreadId}` : ''}`,
      value: <ChildState state={member.state} />, icon: <AgentAvatar identity={member.threadId} avatar={member.avatar} size={18} /> });
  }
  const waitingForQuery = query !== searchQuery;
  const groups = [
    { name: t('composer.group.files'), loading: files.loading || waitingForQuery && Boolean(identity || pendingSource), error: files.error, retry: refreshFiles, more: files.more },
    { name: t('composer.group.directories'), loading: directories.loading || waitingForQuery && Boolean(identity || pendingSource), error: directories.error, retry: refreshDirectories, more: directories.more },
    { name: t('composer.group.threads'), loading: visibleThreads?.loading || waitingForQuery && Boolean(identity), error: visibleThreads?.error, retry: refreshThreads, more: visibleThreads?.cursor ? () => setCursor(visibleThreads.cursor!) : undefined },
  ];
  const loading = groups.some(group => group.loading);
  const status = <>
    {fileSelectionDisabled && <p role="status" className="px-2 py-2 typography-meta text-muted-foreground">{fileSelectionDisabled}</p>}
    {groups.map(group => <React.Fragment key={group.name}>
      {group.loading && <p role="status" className="px-2 py-2 typography-micro text-muted-foreground">{group.name} · {t('composer.menu.loading')}</p>}
      {group.error && <p role="alert" className="px-2 py-2 typography-meta text-destructive">{group.name} · {group.error} <button type="button" onClick={group.retry}>{t('composer.menu.retry')}</button></p>}
      {group.more && <button type="button" className="w-full px-2 py-2 text-left typography-meta" onClick={group.more}>{group.name} · {t('composer.menu.more')}</button>}
    </React.Fragment>)}
    {!items.length && !loading && !groups.some(group => group.error) && <p className="px-2 py-3 typography-meta text-muted-foreground">{t('chat.fileMentionAutocomplete.empty')}</p>}
  </>;
  return <ComposerMenu ref={ref} id={menuId} scope={scope} query={searchQuery} items={items} onChoose={id => choices.get(id)?.()} onClose={onClose} onActive={onActive} status={status} />;
});
