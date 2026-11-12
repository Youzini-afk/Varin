import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { folderPath, type Folder, type Conversation } from './data';

export type Editor = { kind: 'move'; item: Conversation } | { kind: 'group'; folder?: Folder; parent: string | null } | { kind: 'rename'; item: Conversation };
const icons: IconName[] = ['briefcase', 'rocket', 'palette', 'book-open', 'lightbulb', 'code-box', 'folder', 'global'];
const colors = ['', 'var(--syntax-keyword)', 'var(--syntax-string)', 'var(--syntax-type)', 'var(--syntax-constant)'];
const colorLabels = ['随主题', '紫色', '绿色', '金色', '青色'];

/** Preview-only editing. Data never leaves the scene or calls a real Host. */
export function OrganizationDialogs({ editor, folders, onClose, onMove, onGroup, onRename }: {
  editor: Editor | null; folders: Folder[]; onClose(): void;
  onMove(id: string, parent: string | null): void; onGroup(folder: Folder): void; onRename(id: string, title: string): void;
}) {
  const last = React.useRef(editor);
  if (editor) last.current = editor;
  const value = editor ?? last.current;
  const [scope, setScope] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<IconName>('briefcase');
  const [color, setColor] = React.useState('');
  React.useEffect(() => {
    if (!editor) return;
    setScope(editor.kind === 'move' ? editor.item.parent : null);
    setSearch('');
    setName(editor.kind === 'group' ? editor.folder?.name ?? '' : editor.item.title);
    setIcon(editor.kind === 'group' ? editor.folder?.icon ?? 'briefcase' : 'briefcase');
    setColor(editor.kind === 'group' ? editor.folder?.color ?? '' : '');
  }, [editor]);
  const path = folderPath(folders, scope);
  const choices = folders.filter(folder => search.trim()
    ? folder.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    : folder.parent === scope);
  const go = (id: string | null) => { setScope(id); setSearch(''); };
  const title = value?.kind === 'move' ? '移动到…' : value?.kind === 'rename' ? '重命名会话' : value?.folder ? '编辑分组' : '新建分组';
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!value) return;
    if (value.kind === 'move') onMove(value.item.id, scope);
    else if (name.trim() && value.kind === 'rename') onRename(value.item.id, name.trim());
    else if (name.trim() && value.kind === 'group') onGroup({ id: value.folder?.id ?? crypto.randomUUID(), parent: value.parent, kind: 'group', name: name.trim(), icon, color });
    else return;
    onClose();
  };
  return <Dialog open={!!editor} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className={cn('gap-5 p-5', value?.kind === 'move' ? 'max-w-[420px]' : 'max-w-[360px]')}>
      <DialogHeader className="gap-2 text-left">
        <DialogTitle className="text-[15px] font-medium">{title}</DialogTitle>
        <DialogDescription className="text-xs">{value?.kind === 'move' ? value.item.title : value?.kind === 'group' ? `位置：${folderPath(folders, value.parent).map(item => item.name).join(' / ') || '全部分类'}` : '修改这段会话的名称'}</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-5">
        {value?.kind === 'move' ? <div>
          <div className="relative"><Icon name="search" className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input autoFocus className="h-9 pl-8 text-xs" placeholder="搜索项目或分组" aria-label="搜索移动位置" value={search} onChange={event => setSearch(event.target.value)} /></div>
          <nav className="org-picker-breadcrumb" aria-label="目标位置路径">
            <button type="button" onClick={() => go(null)}>全部分类</button>
            {path.map(folder => <React.Fragment key={folder.id}><Icon name="arrow-right-s" className="size-3 opacity-60" /><button type="button" onClick={() => go(folder.id)}>{folder.name}</button></React.Fragment>)}
          </nav>
          <div className="h-[208px] overflow-y-auto py-1" aria-label="可移动的位置">
            {choices.map(folder => <button key={folder.id} type="button" className="org-picker-row" onClick={() => go(folder.id)} aria-label={`进入 ${folder.name}`}>
              <Icon name={folder.icon} className="size-4 shrink-0 text-muted-foreground" style={{ color: folder.color || undefined }} />
              <span className="min-w-0 flex-1"><span className="block truncate">{folder.name}</span>{search && <small className="block truncate text-[10px] text-muted-foreground">{folderPath(folders, folder.parent).map(item => item.name).join(' / ') || '全部分类'}</small>}</span>
              <Icon name="arrow-right-s" className="size-4 text-muted-foreground/60" />
            </button>)}
            {!choices.length && <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground"><Icon name={search ? 'search' : 'folder-open'} className="size-6 opacity-50" /><span className="text-xs">{search ? '没有找到匹配的位置' : '此处没有子分组'}</span></div>}
          </div>
          <div className="org-picker-place"><small>移到</small><Icon name={path.at(-1)?.icon ?? 'folder'} className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 truncate" title={path.map(folder => folder.name).join(' / ')}>{path.map(folder => folder.name).join(' / ') || '未分类'}</span></div>
        </div> : <>
          <Input autoFocus aria-label={value?.kind === 'group' ? '分组名称' : '会话名称'} placeholder="名称" value={name} onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault(); } }} />
          {value?.kind === 'group' && <div className="space-y-4">
            <div><span className="mb-2 block text-[11px] text-muted-foreground">图标</span><div className="flex flex-wrap gap-1.5">{icons.map(item => <button type="button" key={item} aria-label={`图标 ${item}`} aria-pressed={icon === item} onClick={() => setIcon(item)} className={cn('flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover', icon === item && 'bg-interactive-selection text-foreground')}><Icon name={item} className="size-4" style={{ color: color || undefined }} /></button>)}</div></div>
            <div><span className="mb-2 block text-[11px] text-muted-foreground">图标颜色</span><div className="flex gap-2">{colors.map((item, index) => <button key={item} type="button" title={colorLabels[index]} aria-label={colorLabels[index]} aria-pressed={color === item} onClick={() => setColor(item)} className={cn('flex size-7 items-center justify-center rounded-full', color === item && 'ring-1 ring-border ring-offset-2 ring-offset-background')}><span className="flex size-4 items-center justify-center rounded-full" style={{ backgroundColor: item || 'var(--muted-foreground)' }}>{color === item && <Icon name="check" className="size-3 text-background" />}</span></button>)}</div></div>
          </div>}
        </>}
        <DialogFooter className="flex-row gap-2"><Button type="button" size="sm" variant="ghost" onClick={onClose}>取消</Button><Button type="submit" size="sm" disabled={value?.kind !== 'move' && !name.trim()}>{value?.kind === 'move' ? '移到这里' : '保存'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
