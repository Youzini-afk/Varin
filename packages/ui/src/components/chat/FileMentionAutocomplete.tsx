import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import type { FamilyMember } from '@varin/protocol';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { getResolvedWorkbenchWorkspaceId, subscribeWorkbenchWorkspace } from '@/lib/extensions/workbench-workspace';
import { useEditorWorkbench } from '@/lib/workbench/editors/hooks';
import { activeEditorTab, listOpenResourceIds } from '@/lib/workbench/editors/groups';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { useFileSearchStore, type VarinFileSearchHit } from '@/stores/useFileSearchStore';
import { useI18n } from '@/lib/i18n';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { ComposerMenu, type ComposerMenuHandle, type ComposerMenuItem } from './composer/ComposerMenu';

export type FileMentionHandle = ComposerMenuHandle;
type FileInfo = VarinFileSearchHit & { directory?: boolean };
export const FileMentionAutocomplete = React.forwardRef<FileMentionHandle, {
  searchQuery: string; workspacePath?: string; api?: ThreadsAPI; identity?: ThreadIdentity;
  attachments?: Array<{ id: string; name: string; snapshotId?: string }>;
  onFileSelect(file: FileInfo): void; onThreadSelect?(identity: ThreadIdentity, name: string): void;
  onAttachmentSelect?(snapshotId: string, name: string): void;
  onClose(): void; menuId?: string; onActive?(id?: string): void;
}>(({ searchQuery, workspacePath, api, identity, attachments = [], onFileSelect, onThreadSelect, onAttachmentSelect, onClose, menuId = 'composer-references', onActive }, ref) => {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const scope = JSON.stringify([host, identity?.threadId, identity?.branchId, workspacePath]);
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
      return [{ path: filePath, name: filePath.split(/[\\/]/).at(-1) ?? filePath, relativePath }];
    });
  }, [workspacePath, workbench, searchQuery]);
  const query = useDebouncedValue(searchQuery, 150);
  const search = useFileSearchStore(state => state.searchFiles);
  const [limit, setLimit] = React.useState(60);
  const [retry, refresh] = React.useReducer(value => value + 1, 0);
  const [files, setFiles] = React.useState<{ scope: string; query: string; rows: FileInfo[]; pending: Array<'file' | 'directory'>; errors: Partial<Record<'file' | 'directory', string>> }>();
  const [threads, setThreads] = React.useState<{ scope: string; query: string; rows: FamilyMember[]; loading: boolean; error?: string; cursor?: string | null }>();
  const [cursor, setCursor] = React.useState<string>();
  React.useEffect(() => { setLimit(60); setCursor(undefined); }, [searchQuery, scope]);
  React.useEffect(() => {
    if (!workspacePath || query !== searchQuery) return;
    let cancelled = false;
    setFiles(previous => ({ scope, query, rows: previous?.scope === scope && previous.query === query ? previous.rows : [], pending: ['file', 'directory'], errors: {} }));
    for (const type of ['file', 'directory'] as const) void search(workspacePath, query, limit, { type }).then(rows => {
      if (cancelled || host !== getRuntimeEndpointGeneration()) return;
      setFiles(previous => previous?.scope !== scope || previous.query !== query ? previous : { ...previous,
        rows: [...previous.rows.filter(item => Boolean(item.directory) !== (type === 'directory')), ...rows.map(item => ({ ...item, directory: type === 'directory' }))],
        pending: previous.pending.filter(item => item !== type) });
    }, cause => {
      if (cancelled || host !== getRuntimeEndpointGeneration()) return;
      setFiles(previous => previous?.scope !== scope || previous.query !== query ? previous : { ...previous,
        pending: previous.pending.filter(item => item !== type), errors: { ...previous.errors, [type]: cause instanceof Error ? cause.message : String(cause) } });
    });
    return () => { cancelled = true; };
  }, [workspacePath, query, searchQuery, limit, retry, scope, search, host]);
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
  const visibleFiles = files?.scope === scope && files.query === searchQuery ? files : undefined;
  const visibleThreads = threads?.scope === scope && threads.query === searchQuery ? threads : undefined;
  const choices = new Map<string, () => void>();
  const items: ComposerMenuItem[] = [];
  for (const attachment of attachments.filter(item => item.snapshotId && item.name.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase()))) {
    const id = `attachment:${attachment.id}`;
    choices.set(id, () => onAttachmentSelect?.(attachment.snapshotId!, attachment.name));
    items.push({ id, group: t('composer.group.attachments'), label: attachment.name, icon: <Icon name="attachment-2" className="size-4" /> });
  }
  const rank = (name: string) => name.toLocaleLowerCase() === searchQuery.toLocaleLowerCase() ? 0 : name.toLocaleLowerCase().startsWith(searchQuery.toLocaleLowerCase()) ? 1 : 2;
  const fileRows = [...new Map([...recentFiles, ...(visibleFiles?.rows ?? [])].map(file => [`${Boolean(file.directory)}:${file.path}`, file])).values()].sort((a, b) => rank(a.name) - rank(b.name));
  for (const directory of [false, true]) for (const file of fileRows.filter(item => Boolean(item.directory) === directory)) {
    const id = `${directory ? 'directory' : 'file'}:${file.path}`;
    choices.set(id, () => onFileSelect(file));
    items.push({ id, group: t(directory ? 'composer.group.directories' : 'composer.group.files'), label: file.name, description: file.relativePath,
      source: workspacePath, icon: directory ? <Icon name="folder" className="size-4" /> : <FileTypeIcon filePath={file.path} className="size-4" /> });
  }
  for (const member of visibleThreads?.rows ?? []) for (const branch of member.branches) {
    const id = `thread:${member.threadId}:${branch.branchId}`;
    const name = member.name || member.agentId || member.threadId;
    choices.set(id, () => onThreadSelect?.({ runtime: 'agent', threadId: member.threadId, branchId: branch.branchId }, name));
    items.push({ id, group: t('composer.group.threads'), label: name, description: `${member.task ?? ''} · ${branch.branchId}${member.parentThreadId ? ` · ${member.parentThreadId}` : ''}`,
      value: member.state, icon: <AgentAvatar identity={member.threadId} avatar={member.avatar} size={18} /> });
  }
  const loading = (query !== searchQuery && Boolean(workspacePath || identity)) || Boolean(visibleFiles?.pending.length) || visibleThreads?.loading;
  const moreFiles = Boolean(visibleFiles && (['file', 'directory'] as const).some(type => visibleFiles.rows.filter(item => Boolean(item.directory) === (type === 'directory')).length >= limit));
  const status = <>
    {loading && <p role="status" className="px-2 py-2 typography-micro text-muted-foreground">{t('composer.menu.loading')}</p>}
    {[...Object.values(visibleFiles?.errors ?? {}), visibleThreads?.error].filter(Boolean).map((error, index) => <p role="alert" key={index} className="px-2 py-2 typography-meta text-destructive">{error} <button type="button" onClick={refresh}>{t('composer.menu.retry')}</button></p>)}
    {(moreFiles || visibleThreads?.cursor) && <button type="button" className="w-full px-2 py-2 text-left typography-meta" onClick={() => { if (moreFiles) setLimit(value => value + 60); if (visibleThreads?.cursor) setCursor(visibleThreads.cursor); }}>{t('composer.menu.more')}</button>}
    {!items.length && !loading && <p className="px-2 py-3 typography-meta text-muted-foreground">{t('chat.fileMentionAutocomplete.empty')}</p>}
  </>;
  return <ComposerMenu ref={ref} id={menuId} scope={scope} query={searchQuery} items={items} onChoose={id => choices.get(id)?.()} onClose={onClose} onActive={onActive} status={status} />;
});
