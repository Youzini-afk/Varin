import { assertFileEnumeration } from '@/lib/projectFileOperations';
import React from 'react';
import { getRuntimeKey, createResourceFilesHttpAPI, type ResourceFileEntry, type ResourceFileLocation, type ResourceFilePage, type ResourceFileResult } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { DocumentCodeMirror } from '@/components/ui/DocumentCodeMirror';
import { DocumentMonacoEditor } from '@/components/workbench/DocumentMonacoEditor';
import { DocumentEncodingMenu, DocumentEncodingNotice } from '@/components/workbench/DocumentEncodingMenu';
import { DocumentConflictBanner } from '@/components/workbench/DocumentConflictBanner';
import { getResourceDocumentScope, retainResourceWorkspace } from '@/lib/documents/resource-session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import { useDeviceInfo } from '@/lib/device';
import { BUILTIN_EDITOR_PROVIDER_IDS, type EditorViewState } from '@/lib/workbench/editors/types';
import { requestFileEditorNavigation } from '@/lib/monaco/editor-command-service';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { useI18n } from '@/lib/i18n';
import type { BotWorkItem, ThreadIdentity, ThreadSourceTargets } from '@varin/application-client';
import type { SourceResourceOwner } from '@varin/protocol';
type FileSelection = Pick<ResourceFileEntry, 'path' | 'name' | 'kind'> & Partial<Pick<ResourceFileEntry, 'size' | 'modifiedAt' | 'unavailable'>> & { match?: import('@varin/application-client').WorkspaceContentSearchHit };
type FileViewPage = Omit<ResourceFilePage, 'entries'> & { entries: FileSelection[]; incomplete?: boolean };
const workKey = (identity: ThreadIdentity) => `${identity.threadId}\u0000${identity.branchId}`;
export interface ResourceFilesViewLocation { selection?: import('@varin/application-client').ProjectSourceSelection; kind: 'files'; key: string; owner: SourceResourceOwner; title: string; task?: ThreadIdentity; path?: string }
export interface ResourceFilesNavigation { sources: ThreadSourceTargets | null; cite(location: ResourceFileLocation, path: string, target?: ThreadIdentity): Promise<void> }

const join = (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const mime = (name: string) => /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : /\.gif$/i.test(name) ? 'image/gif' : /\.pdf$/i.test(name) ? 'application/pdf' : 'application/octet-stream';

/** Explicitly scoped files; opening or changing a location never changes the chat's launch source. */
export function ResourceFilesView({ view, active, setCloseGuard, workItems, navigation }: { view: ResourceFilesViewLocation; active: boolean; setCloseGuard?(guard: (() => boolean) | null): void; workItems?: BotWorkItem[]; navigation?: ResourceFilesNavigation | null }) {
  const { t } = useI18n();
  const api = React.useMemo(createResourceFilesHttpAPI, []);
  const [location, setLocation] = React.useState<ResourceFileLocation>();
  const [roots, setRoots] = React.useState<string[]>([]);
  const [rootDraft, setRootDraft] = React.useState(view.path ?? '');
  const [directory, setDirectory] = React.useState('');
  const [query, setQuery] = React.useState('');
  const search = React.useDeferredValue(query);
  const [searchMode, setSearchMode] = React.useState<'files' | 'content'>('files');
  const showHidden = useDirectoryShowHidden(), showGitignored = useFilesViewShowGitignored();
  const [page, setPage] = React.useState<FileViewPage>();
  const [selected, setSelected] = React.useState<FileSelection>();
  const scope = React.useMemo(() => getResourceDocumentScope(view.owner), [view.owner]);
  const identity = React.useMemo(() => location && selected && selected.kind !== 'directory' ? { workspaceId: location.workspaceId, resourceId: selected.path } : undefined, [location, selected]);
  const document = useDocumentRecord(identity, scope.documents);
  const editorViewId = React.useMemo(() => `resource-preview:${JSON.stringify([getRuntimeKey(), view.owner, location?.workspaceId, location?.selection, location?.root, view.key])}`, [view.owner, view.key, location]);
  const [editorState, setEditorState] = React.useState<EditorViewState>({});
  const { isMobile } = useDeviceInfo();
  const [editing, setEditing] = React.useState(false);
  const [preview, setPreview] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  const [dialog, setDialog] = React.useState<'newFile' | 'newFolder' | 'rename' | 'copy' | 'move' | 'giveWork'>();
  const [value, setValue] = React.useState('');
  const [targetWork, setTargetWork] = React.useState('');
  const [destinationOwner, setDestinationOwner] = React.useState(view.owner);
  const [destinationRoot, setDestinationRoot] = React.useState('');
  const upload = React.useRef<HTMLInputElement>(null);
  const operation = React.useRef(false), generation = React.useRef(0);
  const listKey = React.useRef('');
  const currentPage = React.useRef(page); currentPage.current = page;
  const dirty = document?.dirty ?? false;
  const dirtyNow = React.useRef(dirty); dirtyNow.current = dirty;
  const mayLeave = React.useCallback(() => {
    if (!dirtyNow.current) return true;
    if (!window.confirm(t('bot.workspace.discard'))) return false;
    if (identity) scope.documents.discard(identity);
    return true;
  }, [t, identity, scope]);
  React.useEffect(() => { setCloseGuard?.(mayLeave); return () => setCloseGuard?.(null); }, [setCloseGuard, mayLeave]);
  React.useEffect(() => () => { generation.current += 1; }, []);
  React.useEffect(() => location ? retainResourceWorkspace(scope, location.workspaceId) : undefined, [location, scope]);
  React.useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const perform = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(undefined); setNotice(undefined);
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { operation.current = false; setBusy(false); }
  };
  const openRoot = async (path?: string, task?: typeof view.task, selection?: ResourceFileLocation['selection']) => {
    if (!mayLeave()) return;
    const version = ++generation.current;
    const result = await api.request({ resourceOwner: view.owner, ...(selection ? {selection} : {}), ...(task ? { task } : {}), command: { kind: 'open', ...(path ? { path } : {}) } });
    if (version !== generation.current || result.kind !== 'opened') return;
    setLocation({ resourceOwner: view.owner, root: result.root, workspaceId: result.workspaceId, ...(selection ? {selection} : {}), ...(task ? { task } : {}) });
    setRoots(result.locations); setRootDraft(result.root); setDirectory(''); setQuery(''); setSelected(undefined); setEditing(false); setPage(undefined);
  };
  React.useEffect(() => { if (active && !location && !error && !operation.current) void perform(() => openRoot(view.path, view.task, view.selection)); });
  React.useEffect(() => {
    if (!location || !active) return;
    const abort = new AbortController();
    const nextKey = JSON.stringify([location, directory, search, searchMode, showHidden, showGitignored]);
    const count = listKey.current === nextKey ? currentPage.current?.entries.length ?? 0 : 0;
    if (listKey.current !== nextKey) { setPage(undefined); listKey.current = nextKey; }
    void (async (): Promise<FileViewPage> => {
      if (search.trim()) {
        if (searchMode === 'content') {
          const result = await api.request({ ...location, command: { kind: 'content-search', path: '', query: search, includeHidden: showHidden, respectGitignore: !showGitignored } }, abort.signal);
          if (result.kind !== 'content-search') throw new Error('Source content search is unavailable');
          if (result.result.status === 'cancelled') throw new DOMException('Source search cancelled', 'AbortError');
          if (result.result.status === 'failure') throw new Error(result.result.message);
          return { path: '', nextCursor: null, entries: result.result.status === 'ready' ? result.result.hits.map(hit => ({ name: hit.resource.resourceId.split('/').pop() ?? hit.resource.resourceId, path: hit.resource.resourceId, kind: 'file', match: hit })) : [], incomplete: result.result.status === 'ready' && result.result.incomplete };
        }
        const result = await api.request({ ...location, command: { kind: 'filename-search', path: '', query: search, includeHidden: showHidden, respectGitignore: !showGitignored } }, abort.signal);
        if (result.kind !== 'filename-search') throw new Error('Source filename search is unavailable');
        assertFileEnumeration(result.enumerationStatus);
        return { path: '', nextCursor: null, entries: result.results.map(hit => ({ name: hit.path.split('/').pop() ?? hit.path, path: hit.path, kind: 'file' })), incomplete: result.enumerationStatus === 'incomplete' };
      }
      const first = await api.request({ ...location, command: { kind: 'list', path: directory, query: search } }, abort.signal);
      if (first.kind !== 'list') throw new Error('Directory response is unavailable');
      const result = first.page;
      while (result.nextCursor && result.entries.length < count) {
        const next = await api.request({ ...location, command: { kind: 'list', path: directory, query: search, cursor: result.nextCursor } }, abort.signal);
        if (next.kind !== 'list') throw new Error('Directory response is unavailable');
        result.entries.push(...next.page.entries); result.nextCursor = next.page.nextCursor;
      }
      return result;
    })().then(result => {
      if (!abort.signal.aborted) { setPage(result); setError(undefined); }
    }, error => { if (!abort.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) setError(String(error)); });
    return () => abort.abort();
  }, [api, location, directory, search, searchMode, showHidden, showGitignored, revision, active]);
  React.useEffect(() => {
    if (!location || !active) return;
    let frame = 0;
    const subscription = scope.api.watch(location.workspaceId, event => {
      if (event.kind === 'dirty-state-barrier' || event.kind === 'surface-operation') return;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    });
    return () => { subscription.close(); if (frame) cancelAnimationFrame(frame); };
  }, [active, location, scope]);
  const go = (path: string) => { if (mayLeave()) { generation.current += 1; setDirectory(path); setSelected(undefined); setPreview(undefined); setEditing(false); } };
  const bytes = async (path: string): Promise<Blob> => {
    if (!location) throw new Error(t('bot.workspace.location'));
    let first: Extract<ResourceFileResult, { kind: 'bytes' }> | undefined, offset = 0;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for (;;) {
      const result = await api.request({ ...location, command: { kind: 'bytes', path, offset } });
      if (result.kind !== 'bytes') throw new Error('File content unavailable');
      first ??= result;
      if (result.version !== first.version || result.byteLength !== first.byteLength) throw new Error(t('bot.workspace.conflict'));
      chunks.push(Uint8Array.from(atob(result.bytesBase64), char => char.charCodeAt(0)));
      if (result.eof) return new Blob(chunks, { type: mime(path) });
      if (result.nextOffset <= offset) throw new Error('Incomplete file content');
      offset = result.nextOffset;
    }
  };
  const pick = async (entry: FileSelection) => {
    if (selected?.path === entry.path && selected.match?.line === entry.match?.line && selected.match?.column === entry.match?.column) return;
    if (!location || !mayLeave()) return;
    const current = ++generation.current;
    setSelected(entry); setPreview(undefined); setEditing(false); setEditorState({});
    if (entry.kind === 'directory') return;
    await scope.documents.open({ workspaceId: location.workspaceId, resourceId: entry.path });
    if (current !== generation.current) return;
    if (entry.match) requestFileEditorNavigation({ workspaceId: location.workspaceId, resourceId: entry.path }, entry.match.line, entry.match.column, editorViewId);
    if (mime(entry.name) !== 'application/octet-stream') {
      const blob = await bytes(entry.path);
      if (current === generation.current) setPreview(URL.createObjectURL(blob));
    }
  };
  const save = () => perform(async () => {
    if (!identity) return;
    const result = await scope.documents.save(identity);
    if (result.dirty || result.errorMessage) throw new Error(result.errorMessage || t('bot.workspace.conflict'));
    setNotice(t('bot.workspace.saved')); refresh();
  });
  const download = () => perform(async () => {
    if (!selected) return;
    const blob = await bytes(selected.path), url = URL.createObjectURL(blob), link = window.document.createElement('a');
    link.href = url; link.download = selected.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const formAction = () => perform(async () => {
    if (!location || !dialog) return;
    if (dialog === 'giveWork') {
      const item = workItems?.find(item => workKey(item.identity) === targetWork);
      if (selected && item) await navigation?.cite(location, selected.path, item.identity);
    } else {
      const name = value.trim(); if (!name) return;
      const path = join(directory, name), key = crypto.randomUUID();
      if (dialog === 'newFolder') await api.request({ ...location, command: { kind: 'mkdir', path } });
      else if (dialog === 'newFile') {
        const resource = { workspaceId: location.workspaceId, resourceId: path };
        const before = await scope.api.read(resource);
        const result = await scope.api.write({ resource, token: { workspaceId: location.workspaceId, epoch: before.epoch, owner: { kind: 'user-files', id: key } }, content: '', expectedRevision: null, encoding: 'utf-8', bom: false, operationId: key });
        if (result.status !== 'written') throw new Error(t('bot.workspace.conflict'));
      } else if (selected) {
        if (dialog !== 'rename' && (JSON.stringify(destinationOwner) !== JSON.stringify(location.resourceOwner) || destinationRoot !== location.root)) {
          const opened = await api.request({ resourceOwner: destinationOwner, command: { kind: 'open', path: destinationRoot } });
          if (opened.kind !== 'opened') throw new Error('Destination unavailable');
          const transfer = await api.transfer({ source: location, path: selected.path, destination: { resourceOwner: destinationOwner, root: opened.root, workspaceId: opened.workspaceId }, destinationPath: name, move: dialog === 'move', key });
          if (transfer.error) throw new Error(`${transfer.copied} ${t('bot.workspace.copy')} · ${transfer.removed} ${t('bot.workspace.move')}\n${transfer.error}`);
        } else await api.request({ ...location, command: { kind: dialog === 'copy' ? 'copy' : 'rename', path: selected.path, destination: dialog === 'rename' ? path : name, key } });
      }
      setSelected(undefined);
    }
    setDialog(undefined); refresh();
  });
  const openDialog = (next: NonNullable<typeof dialog>) => { setDestinationOwner(view.owner); setDestinationRoot(location?.root ?? ''); setValue(next === 'rename' ? selected?.name ?? '' : next === 'copy' || next === 'move' ? selected?.path ?? '' : ''); setDialog(next); };
  return <div className="bot-files-view">
    <div className="bot-files-location"><Icon name="folder" className="size-4" /><span>{view.title}<small>{location?.task ? t('bot.workspace.sourceFixed') : t('bot.workspace.originalDirectory')}</small></span>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={t('bot.workspace.location')}><Icon name="arrow-down-s" className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent>{roots.map(root => <DropdownMenuItem key={root} onSelect={() => void perform(() => openRoot(root))}>{root}</DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void perform(async () => { const result = await api.request({ resourceOwner: view.owner, command: { kind: 'locations' } }); if (result.kind === 'locations') setRoots(result.locations); })}>{t('bot.workspace.refreshLocations')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <form onSubmit={event => { event.preventDefault(); void perform(() => openRoot(rootDraft, undefined)); }}><Input aria-label={t('bot.workspace.path')} value={rootDraft} onChange={event => setRootDraft(event.target.value)} placeholder={t('bot.workspace.home')} /><Button size="sm" type="submit" disabled={busy}>{t('bot.workspace.open')}</Button></form>
    </div>
    <div className="bot-files-toolbar"><button type="button" disabled={!directory || busy} onClick={() => go(directory.split('/').slice(0, -1).join('/'))} aria-label={t('bot.workspace.parent')}><Icon name="arrow-up" className="size-4" /></button>
      <nav aria-label={t('bot.workspace.location')}><button type="button" onClick={() => go('')}>{location?.root ?? t('bot.workspace.home')}</button>{directory.split('/').filter(Boolean).map((part, i, all) => <React.Fragment key={i}><Icon name="arrow-right-s" className="size-3" /><button type="button" onClick={() => go(all.slice(0, i + 1).join('/'))}>{part}</button></React.Fragment>)}</nav>
      <button type="button" aria-label={t('bot.workspace.refresh')} onClick={refresh}><Icon name="refresh" className="size-4" /></button>
    </div>
    <div className="bot-files-tools"><div className="flex gap-1">{(['files', 'content'] as const).map(mode => <Button key={mode} size="sm" variant="ghost" aria-pressed={searchMode === mode} onClick={() => setSearchMode(mode)}>{t(mode === 'files' ? 'workbench.ide.search.filesTab' : 'workbench.ide.search.contentTab')}</Button>)}</div><Input aria-label={t('bot.workspace.search')} placeholder={t('bot.workspace.search')} value={query} onChange={event => setQuery(event.target.value)} />
      <Button size="sm" variant="ghost" disabled={!location || busy} onClick={() => upload.current?.click()}><Icon name="arrow-up" className="size-4" />{t('bot.workspace.upload')}</Button>
      <Button size="sm" variant="ghost" aria-label={t('bot.workspace.newFolder')} disabled={!location || busy} onClick={() => openDialog('newFolder')}><Icon name="folder-add" className="size-4" /></Button>
      <Button size="sm" variant="ghost" disabled={!location || busy} onClick={() => openDialog('newFile')} aria-label={t('bot.workspace.newFile')}><Icon name="add" className="size-4" /></Button>
      <input ref={upload} hidden type="file" multiple onChange={event => { const files = [...event.target.files ?? []]; event.target.value = ''; void perform(async () => { if (!location) return; for (const file of files) { setNotice(`${t('bot.workspace.upload')} · ${file.name}`); await api.upload(location, join(directory, file.name), file, crypto.randomUUID()); } setNotice(t('bot.workspace.transferDone')); refresh(); }); }} />
    </div>
    {error && <p role="alert" className="bot-files-feedback text-destructive">{error} <button onClick={() => { setError(undefined); refresh(); }}>{t('settings.harness.retry')}</button></p>}
    {page?.incomplete && <p role="status" className="bot-files-feedback text-muted-foreground">{t('files.search.incomplete')}</p>}
    {notice && <p role="status" className="bot-files-feedback text-muted-foreground">{notice}</p>}
    <div className="bot-files-body">
      <nav className="bot-files-roots" aria-label={t('bot.workspace.location')}>{roots.map(root => <button type="button" key={root} onClick={() => void perform(() => openRoot(root, undefined))}><Icon name="folder" className="size-3.5" />{root}</button>)}</nav>
      <div className="bot-file-list" role="list" aria-label={t('bot.workspace.files')}>
        {!page && !error && <p role="status">{t('common.loading')}</p>}
        {page?.entries.map(entry => <button type="button" key={`${entry.path}:${entry.match?.line ?? 0}:${entry.match?.column ?? 0}`} role="listitem" className="bot-file-row" aria-current={selected?.path === entry.path} onClick={() => void perform(() => pick(entry))} onDoubleClick={() => { if (entry.kind === 'directory') go(entry.path); }} onContextMenu={event => { event.preventDefault(); void perform(() => pick(entry)); }}>
          <Icon name={entry.kind === 'directory' ? 'folder' : 'file-text'} className="size-4" /><span>{search.trim() ? entry.path : entry.name}{entry.match && <small>{entry.match.line}:{entry.match.column} · {entry.match.preview}</small>}</span><small title={entry.unavailable}>{entry.unavailable ? '—' : entry.kind === 'directory' || entry.size === undefined ? '' : size(entry.size)}</small></button>)}
        {page && !page.entries.length && <p>{t(query ? 'bot.workspace.noMatch' : 'bot.workspace.emptyDirectory')}</p>}
        {page?.nextCursor && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(async () => { const result = await api.request({ ...location!, command: { kind: 'list', path: directory, query: search, cursor: page.nextCursor! } }); if (result.kind === 'list') setPage({ ...result.page, entries: [...page.entries, ...result.page.entries] }); })}>{t('bot.workspace.more')}</Button>}
      </div>
      {selected && <section className="bot-file-preview" aria-label={t('bot.workspace.preview')}>
        <header><button type="button" className="float-right p-1 text-muted-foreground" aria-label={t('bot.workspace.close')} onClick={() => { if (mayLeave()) { setSelected(undefined); setPreview(undefined); setEditing(false); } }}><Icon name="close" className="size-4" /></button><b>{selected.name}</b><small>{selected.unavailable ?? `${selected.size === undefined ? '' : size(selected.size)} · ${selected.modifiedAt === undefined ? '' : new Date(selected.modifiedAt).toLocaleString()}`}</small></header>
        {identity && <div className="bot-file-conflict"><DocumentConflictBanner identity={identity} registry={scope.documents} /><DocumentEncodingNotice identity={identity} registry={scope.documents} /></div>}
        <div className="bot-file-content">{preview ? mime(selected.name) === 'application/pdf' ? <iframe title={selected.name} src={preview} /> : <img alt={selected.name} src={preview} />
          : identity && document && ['ready', 'conflict', 'deleted'].includes(document.status) ? isMobile ? <DocumentCodeMirror identity={identity} registry={view.owner.kind === 'local' ? undefined : scope.documents} readOnly={!editing || busy} className="h-full" />
            : <DocumentMonacoEditor identity={identity} path={`${location?.root}/${selected.path}`} providerId={BUILTIN_EDITOR_PROVIDER_IDS.text} viewId={editorViewId} viewState={editorState} onViewStateChange={setEditorState} scope={view.owner.kind === 'local' ? undefined : scope} readOnly={!editing || busy} className="h-full" />
            : document && document.status !== 'loading' ? <p>{t('bot.workspace.noPreview')}</p> : selected.kind === 'directory' ? null : <p>{t('common.loading')}</p>}</div>
        <div className="bot-file-actions">
          {selected.kind === 'directory' && <Button size="sm" onClick={() => go(selected.path)}>{t('bot.workspace.open')}</Button>}
          {selected.kind !== 'directory' && <><Button size="sm" variant="outline" disabled={busy || !location || !navigation} onClick={() => void perform(async () => { await navigation?.cite(location!, selected.path); setNotice(t('bot.workspace.referenced')); })}>{t('bot.workspace.reference')}</Button>
          <Button size="sm" variant="ghost" disabled={busy || !workItems?.length || !navigation} onClick={() => openDialog('giveWork')}>{t('bot.workspace.giveWork')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void download()}>{t('bot.workspace.download')}</Button></>}
          {document && ['ready', 'conflict'].includes(document.status) && <Button size="sm" variant="ghost" disabled={busy || document.saving} onClick={() => editing ? void save() : setEditing(true)}>{t(editing ? 'bot.workspace.save' : 'bot.workspace.edit')}{dirty ? ' *' : ''}</Button>}
          {identity && document && <DocumentEncodingMenu identity={identity} registry={scope.documents}><Button size="sm" variant="ghost" aria-label={t('filesView.encoding.save')}><Icon name="more" className="size-4" /></Button></DocumentEncodingMenu>}
          {(['rename', 'copy', 'move'] as const).map(action => <Button key={action} size="sm" variant="ghost" disabled={busy || dirty} onClick={() => openDialog(action)}>{t(`bot.workspace.${action}`)}</Button>)}
          <Button size="sm" variant="ghost" disabled={busy || dirty} onClick={() => { if (window.confirm(t('bot.workspace.deleteConfirm', { name: selected.name, device: view.title }))) void perform(async () => { await api.request({ ...location!, command: { kind: 'remove', path: selected.path, key: crypto.randomUUID() } }); setSelected(undefined); refresh(); }); }}>{t('bot.workspace.delete')}</Button>
        </div>
      </section>}
    </div>
    <Dialog open={Boolean(dialog)} onOpenChange={open => { if (!open && !busy) setDialog(undefined); }}><DialogContent><DialogHeader><DialogTitle>{dialog ? t(`bot.workspace.${dialog}`) : ''}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void formAction(); }}>
        {(dialog === 'copy' || dialog === 'move') && <div className="mb-3 grid gap-2"><label>{t('bot.workspace.selectDevice')}<select className="mt-1 w-full rounded-md border border-border bg-background p-2" value={JSON.stringify(destinationOwner)} onChange={event => { setDestinationOwner(JSON.parse(event.target.value)); setDestinationRoot(''); }}>{(navigation?.sources?.targets ?? [{ resourceOwner: view.owner, label: view.title }]).map(target => <option key={JSON.stringify(target.resourceOwner)} value={JSON.stringify(target.resourceOwner)}>{target.label}</option>)}</select></label><label>{t('bot.workspace.path')}<Input value={destinationRoot} placeholder={t('bot.workspace.home')} onChange={event => setDestinationRoot(event.target.value)} /></label></div>}
        {dialog === 'giveWork' ? <select aria-label={t('bot.workspace.chooseWork')} value={targetWork} onChange={event => setTargetWork(event.target.value)}><option value="">{t('bot.workspace.chooseWork')}</option>{workItems?.filter(item => item.purpose === 'work' || item.purpose === 'followed').map(item => <option key={workKey(item.identity)} value={workKey(item.identity)}>{item.thread.title}</option>)}</select>
          : <label className="grid gap-2">{t(dialog === 'copy' || dialog === 'move' ? 'bot.workspace.destination' : 'bot.workspace.name')}<Input value={value} onChange={event => setValue(event.target.value)} autoFocus /></label>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <DialogFooter className="mt-4"><Button type="button" variant="ghost" disabled={busy} onClick={() => setDialog(undefined)}>{t('bot.workspace.cancel')}</Button><Button type="submit" disabled={busy || (dialog === 'giveWork' ? !targetWork : !value.trim())}>{t('bot.workspace.save')}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </div>;
}
