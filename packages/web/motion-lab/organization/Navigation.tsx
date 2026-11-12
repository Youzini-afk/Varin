import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { FlipList } from '@/components/conversation/FlipList';
import { useHoverPill, useSelectionGlide } from '@/components/conversation/sidebarHighlights';
import { SwapIcon } from '@/components/motion/SwapIcon';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { bots, folderPath, type Folder, type Conversation, type DesignMode } from './data';
import type { Editor } from './Dialogs';

type Action = { label: string; icon: IconName; run(): void; danger?: boolean };
const iconButton = 'org-icon-button';
export function BotPortrait({ id = 'varin', size = 20 }: { id?: string; size?: number }) {
  return <BotFigure appearance={{ kind: 'varin', color: bots.find(bot => bot.id === id)?.color ?? 'theme' }} state="idle" size={size} still />;
}
function RowMenu({ actions }: { actions: Action[] }) {
  return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={iconButton} aria-label="更多操作"><Icon name="more" className="size-3.5" /></button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-44">{actions.map(action => <DropdownMenuItem key={action.label} variant={action.danger ? 'destructive' : 'default'} onClick={action.run}><Icon name={action.icon} className="size-3.5" />{action.label}</DropdownMenuItem>)}</DropdownMenuContent>
  </DropdownMenu>;
}
function RowContext({ actions, children }: { actions: Action[]; children: React.ReactElement }) {
  return <ContextMenu><ContextMenuTrigger asChild>{children}</ContextMenuTrigger><ContextMenuContent>{actions.map(action => <ContextMenuItem key={action.label} onClick={action.run} className={action.danger ? 'text-destructive' : undefined}><Icon name={action.icon} className="size-3.5" />{action.label}</ContextMenuItem>)}</ContextMenuContent></ContextMenu>;
}
function Fold({ open, children, task = false }: React.PropsWithChildren<{ open: boolean; task?: boolean }>) {
  return <div className="org-fold" style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }} inert={!open}><div className="org-fold-inner"><div className={task ? 'org-task-children' : 'org-children'}>{children}</div></div></div>;
}

export function OrganizationNavigation({ mode, folders, items, active, onSelect, onEdit, onNew, onArchive, onPin, onNotice }: {
  mode: DesignMode; folders: Folder[]; items: Conversation[]; active: string;
  onSelect(id: string): void; onEdit(value: Editor): void; onNew(parent: string | null, bot?: string): void;
  onArchive(id: string): void; onPin(id: string): void; onNotice(text: string): void;
}) {
  const [view, setView] = React.useState<'recent' | 'classified'>('classified');
  const [searching, setSearching] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState(() => new Set(['work', 'varin-project', 'release']));
  const [focus, setFocus] = React.useState<string | null>(null);
  const [archive, setArchive] = React.useState(false);
  const [botBrowser, setBotBrowser] = React.useState(false);
  const [botScope, setBotScope] = React.useState<string | null>('varin');
  const [chosenBot, setChosenBot] = React.useState('varin');
  const list = React.useRef<HTMLDivElement>(null);
  useSelectionGlide(list, active);
  useHoverPill(list);
  React.useEffect(() => { setFocus(null); setQuery(''); setSearching(false); setArchive(false); }, [mode]);
  const activePath = JSON.stringify(folderPath(folders, items.find(item => item.id === active)?.parent ?? null).map(folder => folder.id));
  React.useEffect(() => { setExpanded(previous => new Set([...previous, ...JSON.parse(activePath) as string[]])); }, [active, activePath]);
  const directBot = items.find(item => item.id === active && item.direct)?.bot;
  React.useEffect(() => { if (mode === 'bot' && directBot) setChosenBot(directBot); }, [mode, directBot]);
  const toggle = (id: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const filtered = items.filter(item => !!item.archived === archive && (mode !== 'bot' || !botBrowser || !botScope || item.bot === botScope));
  const folderVisible = (folder: Folder) => mode !== 'bot' || !botBrowser || !botScope || filtered.some(item => folderPath(folders, item.parent).some(parent => parent.id === folder.id));
  const actionsFor = (item: Conversation): Action[] => [
    { label: '重命名', icon: 'pencil-ai', run: () => onEdit({ kind: 'rename', item }) },
    { label: item.pinned ? '取消置顶' : '置顶', icon: 'pushpin', run: () => onPin(item.id) },
    { label: '移动到…', icon: 'folder-received', run: () => onEdit({ kind: 'move', item }) },
    ...(item.bot && !item.direct ? [{ label: '查看发起会话', icon: 'arrow-go-back' as const, run: () => onSelect(item.bot === 'varin' ? 'release-talk' : 'native') }] : []),
    { label: archive ? '恢复会话' : '归档会话', icon: archive ? 'history' : 'inbox-archive', run: () => onArchive(item.id) },
  ];
  const renderConversation = (item: Conversation, recent = false, nested = false): React.ReactNode => {
    const children = filtered.filter(child => child.childOf === item.id);
    const open = expanded.has(item.id);
    const actions = actionsFor(item);
    const botName = bots.find(bot => bot.id === item.bot)?.name;
    return <div key={item.id} data-flip-key={item.id} data-collapsed={children.length && !open ? '' : undefined}>
      <RowContext actions={actions}><div className="org-row" data-current={active === item.id || undefined} data-sidebar-row={item.id} data-recent={recent || undefined}>
        {!recent && !nested && <button type="button" className="org-chevron" data-open={open} aria-label={`${open ? '收起' : '展开'} ${item.title}的子任务`} disabled={!children.length} onClick={() => toggle(item.id)}><Icon name="arrow-right-s" className={cn('size-3', !children.length && 'invisible')} /></button>}
        <button type="button" className="org-row-main" aria-current={active === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)} title={item.title}>
          {item.direct ? <BotPortrait id={item.bot} /> : <AgentAvatar identity={item.id} size={20} role={item.bot && !nested ? 'lead' : undefined} />}
          <span className="org-row-title"><span>{item.title}</span>{recent && <span className="org-row-path">{folderPath(folders, item.parent).map(folder => folder.name).join(' / ') || '未分类'}</span>}</span>
        </button>
        {item.bot && !item.direct && <Tooltip><TooltipTrigger asChild><span className="inline-flex shrink-0 opacity-75" aria-label={`由${botName}派发`}><BotPortrait id={item.bot} size={14} /></span></TooltipTrigger><TooltipContent side="right">由 {botName} 从「准备下一个版本」派发</TooltipContent></Tooltip>}
        <SwapIcon swapKey={item.state ?? (item.pinned ? 'pinned' : 'none')} className="shrink-0">
          {item.state === 'working' ? <span className="bot-ring mx-1" aria-label="正在执行" /> : item.state === 'waiting' ? <Icon name="question" className="mx-0.5 size-3.5 text-[var(--status-warning)]" aria-label="需要你确认" /> : item.state === 'unread' ? <span className="mx-1 size-1.5 rounded-full bg-primary" aria-label="有新结果" /> : item.pinned ? <Icon name="pushpin" className="size-3 opacity-60" /> : null}
        </SwapIcon>
        {recent && <time className="org-row-time">{item.time}</time>}
        <div className="org-row-actions"><RowMenu actions={actions} /></div>
      </div></RowContext>
      {!recent && children.length > 0 && <Fold open={open} task>{children.map(child => renderConversation(child, false, true))}</Fold>}
    </div>;
  };
  const renderFolder = (folder: Folder): React.ReactNode => {
    const open = expanded.has(folder.id);
    const children = folders.filter(child => child.parent === folder.id && folderVisible(child));
    const members = filtered.filter(item => item.parent === folder.id && !item.childOf);
    const actions: Action[] = [
      { label: '新建会话', icon: 'chat-new', run: () => onNew(folder.id, mode === 'bot' ? chosenBot : undefined) },
      { label: '新建分组', icon: 'folder-add', run: () => onEdit({ kind: 'group', parent: folder.id }) },
      { label: '聚焦此分类', icon: 'fullscreen', run: () => setFocus(folder.id) },
      ...(folder.kind === 'group' ? [{ label: '编辑分组', icon: 'pencil-ai' as const, run: () => onEdit({ kind: 'group', folder, parent: folder.parent }) }] : [{ label: '打开项目文件', icon: 'folder-open' as const, run: () => onNotice('设计预览：项目文件沿用原工作区入口') }]),
    ];
    return <div key={folder.id} data-flip-key={folder.id} data-collapsed={open ? undefined : ''}>
      <RowContext actions={actions}><div className="org-row" data-folder="true" data-sidebar-row={folder.id}>
        <button type="button" className="org-row-main" onClick={() => toggle(folder.id)} aria-expanded={open} title={`${folder.kind === 'project' ? '项目' : '分组'} · ${folder.name}`}>
          <span className="org-chevron" data-open={open}><Icon name="arrow-right-s" className="size-3" /></span>
          <span className="flex size-5 shrink-0 items-center justify-center"><Icon name={folder.icon} className="size-3.5" style={{ color: folder.color || undefined }} /></span>
          <span className="org-row-title"><span>{folder.name}</span></span>
        </button>
        <div className="org-row-actions"><button type="button" className="org-icon-button org-row-new" aria-label={`在${folder.name}中新建会话`} onClick={() => onNew(folder.id, mode === 'bot' ? chosenBot : undefined)}><Icon name="add" className="size-3.5" /></button><RowMenu actions={actions} /></div>
      </div></RowContext>
      <Fold open={open}>{children.map(renderFolder)}{members.map(item => renderConversation(item))}{!children.length && !members.length && <button type="button" className="px-7 py-2 text-[11px] text-muted-foreground/70 hover:text-foreground" onClick={() => onNew(folder.id)}>在这里开始会话</button>}</Fold>
    </div>;
  };
  const recent = filtered.filter(item => !item.childOf).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const results = filtered.filter(item => item.title.includes(query.trim()) || folderPath(folders, item.parent).some(folder => folder.name.includes(query.trim())));
  const focused = folders.find(folder => folder.id === focus);
  const newMenu = <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={iconButton} aria-label="选择新会话对象"><Icon name="arrow-down-s" className="size-3" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => onNew(focus)}><Icon name="chat-new" className="size-4" />普通会话</DropdownMenuItem><DropdownMenuSeparator />{bots.map(bot => <DropdownMenuItem key={bot.id} onClick={() => onNew(focus, bot.id)}><BotPortrait id={bot.id} size={18} />与 {bot.name} 新建会话</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>;
  return <aside className="org-navigation" aria-label="会话导航设计">
    <div className="org-nav-top"><button type="button" className="org-new" onClick={() => onNew(focus, mode === 'bot' ? chosenBot : undefined)}><Icon name="chat-new" className="size-4 shrink-0" /><span className="truncate">{mode === 'bot' ? `与 ${bots.find(bot => bot.id === chosenBot)?.name} 新建会话` : focused ? `在${focused.name}中新建` : '新会话'}</span></button>{newMenu}
      <button type="button" className={iconButton} aria-label="搜索会话" onClick={() => { setSearching(!searching); setQuery(''); }}><Icon name="search" className="size-4" /></button>
      <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={iconButton} aria-label="导航选项"><Icon name="more" className="size-4" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setArchive(!archive)}><Icon name="inbox-archive" className="size-4" />{archive ? '返回会话' : '归档会话'}</DropdownMenuItem><DropdownMenuItem onClick={() => setExpanded(new Set())}><Icon name="arrow-right-s" className="size-4" />收起全部</DropdownMenuItem><DropdownMenuItem onClick={() => setExpanded(new Set(folders.map(folder => folder.id)))}><Icon name="arrow-down-s" className="size-4" />展开全部</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </div>
    {searching && <div className="relative mx-3 mb-2"><Input autoFocus aria-label="搜索会话或分类" placeholder="搜索会话或分类…" className="h-8 pr-7 text-xs" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearching(false); setQuery(''); } }} /><button type="button" aria-label="关闭搜索" className="org-icon-button absolute right-0.5 top-0.5" onClick={() => { setSearching(false); setQuery(''); }}><Icon name="close" className="size-3" /></button></div>}
    {mode === 'bot' && !botBrowser ? <>
      <div className="org-nav-heading"><span>助手</span><button type="button" className={iconButton} aria-label="会话与工作" title="会话与工作" onClick={() => setBotBrowser(true)}><Icon name="folder-open" className="size-3.5" /></button></div>
      <div className="px-2"><p className="org-section-label mt-1">常用</p>{bots.map(bot => <div key={bot.id} className="mb-2"><button type="button" className="org-row w-full gap-2 px-3" data-current={chosenBot === bot.id || undefined} onClick={() => { setChosenBot(bot.id); setBotScope(bot.id); onSelect(bot.id === 'varin' ? 'release-talk' : 'native'); }}><Icon name="arrow-right-s" className={cn('size-3', chosenBot === bot.id && 'rotate-90')} /><BotPortrait id={bot.id} size={22} /><span className="text-[13px]">{bot.name}</span><span className="ml-auto text-[10px] opacity-60">{bot.id === 'varin' ? '工作中' : ''}</span></button>{chosenBot === bot.id && <div className="ml-7">{items.filter(item => item.direct && item.bot === bot.id).map(item => renderConversation(item))}<button type="button" className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground" onClick={() => { setBotBrowser(true); setBotScope(bot.id); }}><Icon name="folder-open" className="size-3" />按分类查看会话与工作<Icon name="arrow-right-s" className="ml-auto size-3" /></button></div>}</div>)}</div>
      <div className="mt-auto" /><button type="button" className="org-nav-footer hover:text-foreground" onClick={() => { setBotBrowser(true); setBotScope(null); }}><Icon name="stack" className="size-3.5" />浏览全部会话<Icon name="arrow-right-s" className="size-3" /></button>
    </> : <>
      {mode === 'bot' && <div className="flex items-center px-3 pb-1"><button type="button" className={iconButton} aria-label="返回助手" onClick={() => setBotBrowser(false)}><Icon name="arrow-left-s" className="size-4" /></button><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="flex min-w-0 items-center gap-1 text-xs">{botScope ? `${bots.find(bot => bot.id === botScope)?.name} 的会话与工作` : '全部会话'}<Icon name="arrow-down-s" className="size-3 text-muted-foreground" /></button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onClick={() => setBotScope(chosenBot)}>当前助手的会话与工作</DropdownMenuItem><DropdownMenuItem onClick={() => setBotScope(null)}>全部会话</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>}
      <div className="org-nav-heading">{focus ? <button type="button" onClick={() => setFocus(null)} className="flex min-w-0 items-center gap-1"><Icon name="arrow-left-s" className="size-3" /><span className="truncate" title={folderPath(folders, focus).map(folder => folder.name).join(' / ')}>{folderPath(folders, focus).map(folder => folder.name).join(' / ')}</span></button> : archive ? <button type="button" onClick={() => setArchive(false)} className="flex items-center gap-1"><Icon name="arrow-left-s" className="size-3" />已归档会话</button> : <div role="tablist" aria-label="会话视角" className="org-view-tabs"><button type="button" role="tab" aria-selected={view === 'recent'} onClick={() => setView('recent')}>最近</button><button type="button" role="tab" aria-selected={view === 'classified'} onClick={() => setView('classified')}>分类</button></div>}
        {!archive && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={iconButton} aria-label="添加分组或项目"><Icon name="add" className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => onEdit({ kind: 'group', parent: focus })}><Icon name="folder-add" className="size-4" />新建分组</DropdownMenuItem><DropdownMenuItem onClick={() => onNotice('设计预览：添加项目复用原项目创建窗口')}><Icon name="code-box" className="size-4" />添加项目</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
      </div>
      <FlipList containerRef={list} layoutKey={JSON.stringify([view, expanded.size, focus, items.map(item => [item.id, item.parent, item.pinned, item.archived])])} instantKey={query} className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {query.trim() ? results.map(item => renderConversation(item, true)) : archive ? filtered.map(item => renderConversation(item, true)) : view === 'recent' && !focus ? recent.map(item => renderConversation(item, true)) : <>{folders.filter(folder => folder.parent === focus && folderVisible(folder)).map(renderFolder)}{filtered.filter(item => item.parent === focus && !item.childOf).length > 0 && <><p className="org-section-label">{focus ? '会话' : '未分类'}</p>{filtered.filter(item => item.parent === focus && !item.childOf).map(item => renderConversation(item))}</>}</>}
        {(archive && !filtered.length || query.trim() && !results.length) && <p className="px-3 py-8 text-center text-xs text-muted-foreground">{archive ? '还没有归档会话' : '没有找到匹配的会话'}</p>}
      </FlipList>
      <button type="button" className="org-nav-footer hover:text-foreground" onClick={() => setArchive(!archive)}><Icon name={archive ? 'arrow-go-back' : 'inbox-archive'} className="size-3.5" />{archive ? '返回会话' : '已归档'}</button>
    </>}
  </aside>;
}
