import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { toast } from '@/components/ui/toast';
import { Toaster } from '@/components/ui/sonner';
import { ThreadComposer } from '@/components/thread/ThreadComposer';
import { ChatTimeline } from '@/components/conversation/ChatTimeline';
import { ConversationContext, type ConversationPresentation } from '@/components/conversation/ConversationContext';
import { useTimelineViewStore } from '@/components/conversation/timelineViewStore';
import type { ChatSessionEntry, ChatSessionMessageEntry } from '@/components/conversation/types';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { OrganizationNavigation, BotPortrait } from './Navigation';
import { OrganizationDialogs, type Editor } from './Dialogs';
import { conversations as initialConversations, folders as initialFolders, folderPath, type Conversation, type DesignMode } from './data';
import { installOrganizationFixtures } from './fixtures';
import { BotWorkPreview } from './BotWorkPreview';
import './organization.css';

// Every preview effect stays in React state. This scene has no execution/Storage owner.
const api = new Proxy({}, { get: () => new Proxy(() => Promise.resolve(undefined), { get: () => () => Promise.resolve(undefined) }) });
const presentation: ConversationPresentation = {
  readOnly: true, api: api as ConversationPresentation['api'], identity: { threadId: 'organization-preview', branchId: 'main' } as ConversationPresentation['identity'],
  head: null, toolExecutions: {}, quote: () => undefined, openFile: () => Promise.resolve(), fileTarget: () => Promise.reject(new Error('Preview has no files')),
};
const noOp = () => undefined;
const models = [{ providerId: 'openai', modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', thinkingLevels: ['off', 'high'] as ['off', 'high'] }];

function history(item: Conversation): ChatSessionEntry[] {
  const user = item.id === 'release-talk' ? '准备发布新版本吧，先检查桌面安装和远程工作区，更新说明也一起整理。'
    : item.id === 'release-task' ? '检查这次发布涉及的关键流程，遇到需要我决定的地方直接告诉我。'
    : item.id === 'navigation' ? '会话现在可以分组了，项目和分组的关系要清楚，Bot 派发的工作也要容易分辨。'
    : `我们继续聊「${item.title}」。`;
  const text = item.id === 'release-talk' ? '我把这次讨论和相关工作放在 **Varin → 版本发布** 里，方便之后接着做。\n\n回归检查已经交给负责的 Agent，重点看桌面安装与远程工作区。更新说明沿用之前版本的写法，整理好后再一起审阅。\n\nWindows 安装流程有一处需要确认，相关任务已经标出来了。'
    : item.id === 'release-task' ? '正在核对桌面启动、安装更新和远程工作区的关键路径。\n\n- 安装与启动：已完成主要路径检查。\n- 远程工作区：继续核对连接与恢复。\n- Windows 安装：有一项等待确认，可从左侧展开子任务进入。'
    : '分类负责把讨论和工作放在容易找到的位置。项目继续提供实际工作环境，Bot 派发的任务保留原来的执行关系。\n\n整理分类后，当前会话和输入草稿会继续留在这里。';
  const now = '2026-11-12T08:30:00+08:00';
  return [
    { id: `${item.id}-user`, parentId: null, timestamp: now, type: 'message', runId: 'preview-round', message: { role: 'user', content: user, timestamp: 1 } },
    { id: `${item.id}-reply`, parentId: `${item.id}-user`, timestamp: now, type: 'message', runId: 'preview-round', message: { id: 'preview-reply', role: 'assistant', api: 'responses', provider: 'OpenAI', model: 'GPT-6.1 Sol', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 2 } },
  ];
}

function ConversationCanvas({ item, path, onMove }: { item: Conversation; path: string; onMove(): void }) {
  const editor = React.useRef<ComposerEditorHandle | null>(null);
  const [draft, setDraft] = React.useState('');
  const [entries, setEntries] = React.useState<ChatSessionEntry[]>(() => item.id.startsWith('draft-') ? [] : history(item));
  React.useState(() => useTimelineViewStore.getState().enter(item.id, entries.at(-1)?.id ?? null, false));
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); if (!draft.trim()) return;
    const entry: ChatSessionMessageEntry = { id: crypto.randomUUID(), parentId: entries.at(-1)?.id ?? null, type: 'message', timestamp: new Date().toISOString(), runId: 'preview-input', message: { role: 'user', content: draft, timestamp: Date.now() } };
    setEntries(current => [...current, entry]); setDraft('');
  };
  return <main className="org-content regular-chat-view [container-type:inline-size]">
    <header className="org-content-heading">
      {item.direct ? <BotPortrait id={item.bot} size={25} /> : <AgentAvatar identity={item.id} size={25} role={item.bot ? 'lead' : undefined} />}
      <div className="min-w-0 flex-1"><h2 className="truncate">{item.title}</h2><button type="button" className="org-content-path max-w-full truncate text-left hover:text-foreground" onClick={onMove} title="查看或调整分类位置">{path || '未分类'}<Icon name="arrow-down-s" className="ml-1 inline size-2.5" /></button></div>
      {item.bot && !item.direct && <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><BotPortrait id={item.bot} size={17} />Varin 派发</span>}
      <button type="button" className="org-icon-button" aria-label="会话详情" onClick={onMove}><Icon name="layout-right" className="size-4" /></button>
    </header>
    <div className="thread-conversation-layout relative flex min-h-0 flex-1 flex-col">
      {entries.length ? <div className="relative min-h-0 flex-1"><ConversationContext.Provider value={{ ...presentation, identity: { ...presentation.identity, threadId: item.id } }}><ChatTimeline sessionId={item.id} cwd="/workspace/Varin" entries={entries} leafId={entries.at(-1)?.id ?? null} toolExecutions={{}} /></ConversationContext.Provider></div>
        : <div className="flex flex-1 flex-col items-center justify-center gap-4"><VarinLogo width={26} height={26} decorative className="text-muted-foreground" /><h2 className="text-xl font-medium">开始一段新的会话</h2><button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onMove}>保存到 {path || '未分类'}</button></div>}
      <div className="thread-composer-stack shrink-0"><form onSubmit={submit}>
        <ThreadComposer editorRef={editor} value={draft} onChange={setDraft} identityKey={`organization-${item.id}`} placement="bottom"
          models={models} providerId="openai" modelId="gpt-6.1-sol" thinkingLevel="high" onModelChange={noOp}
          modelDisabled={false} attachmentDisabled={false} imageDisabled={false} sendDisabled={!draft.trim()}
          pending={false} active={false} retrying={false}
          onFiles={noOp} onAttachImages={noOp} onAttachPdfs={noOp} onGoal={noOp} hasInput={!!draft.trim()} onWorkspace={noOp} workspaceLabel="Varin" attachmentNames={[]} skills={[]} />
      </form></div>
    </div>
  </main>;
}

function IdeEditor() {
  return <section className="org-ide-editor flex min-w-0 flex-1 flex-col border-r border-border">
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 text-xs"><Icon name="file-code" className="size-3.5 text-muted-foreground" />conversation-navigation.ts<span className="ml-2 size-1.5 rounded-full bg-muted-foreground/50" /></div>
    <div className="px-5 pt-3 text-[10px] text-muted-foreground">packages / ui / conversation / navigation</div>
    <pre className="org-ide-code"><code><span className="keyword">export function</span>{' openConversation(target: Target) {\n  ' }<span className="keyword">const</span>{' conversation = catalog.resolve(target);\n\n  '}<span className="keyword">return</span>{' workspace.open({\n    identity: conversation.identity,\n    source: conversation.source,\n  });\n}\n\n'}<span className="keyword">export function</span>{' moveConversation(\n  conversation: Conversation,\n  destination: Container,\n) {\n  ' }<span className="keyword">return</span>{' organization.move({\n    conversation,\n    destination,\n  });\n}\n'}</code></pre>
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-[10px] text-muted-foreground"><Icon name="git-branch" className="size-3" />main<span className="ml-auto">TypeScript</span><span>UTF-8</span></div>
  </section>;
}

/** Real product primitives and chat; proposed navigation composes them only in the lab. */
export function OrganizationDesignLab() {
  React.useLayoutEffect(() => installOrganizationFixtures(), []);
  const { currentTheme, setThemeMode } = useThemeSystem();
  const [mode, setMode] = React.useState<DesignMode>('workbench');
  const [narrow, setNarrow] = React.useState(false);
  const [folders, setFolders] = React.useState(initialFolders);
  const [items, setItems] = React.useState(initialConversations);
  const [active, setActive] = React.useState('release-talk');
  const [sideWork, setSideWork] = React.useState<string | null>(null);
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const item = items.find(item => item.id === active) ?? items[0];
  const path = folderPath(folders, item.parent).map(folder => folder.name).join(' / ');
  const work = sideWork ? items.find(item => item.id === sideWork) : undefined;
  const select = (id: string) => {
    if (mode === 'bot' && !items.find(item => item.id === id)?.direct) setSideWork(id);
    else { setActive(id); setSideWork(null); }
  };
  const switchMode = (next: DesignMode) => { setMode(next); setSideWork(null); if (next === 'bot') setActive('release-talk'); };
  const move = (id: string, parent: string | null) => {
    const previous = items.find(item => item.id === id)!;
    setItems(current => current.map(item => item.id === id ? { ...item, parent, childOf: undefined } : item.childOf === id ? { ...item, parent } : item));
    toast.success(`已移到 ${folderPath(folders, parent).map(folder => folder.name).join(' / ') || '未分类'}`, { action: { label: '撤销', onClick: () => {
      setItems(current => current.map(item => item.id === id ? { ...item, parent: previous.parent, childOf: previous.childOf } : item.childOf === id ? { ...item, parent: previous.parent } : item));
    } } });
  };
  const start = (parent: string | null, bot?: string) => {
    const next: Conversation = { id: `draft-${crypto.randomUUID()}`, parent, title: bot ? `与 ${bot === 'varin' ? 'Varin' : '研究助手'} 的新会话` : '新会话', time: '刚刚', bot, direct: !!bot };
    setItems(current => [next, ...current]); setActive(next.id); setSideWork(null);
  };
  return <RuntimeAPIContext.Provider value={api as React.ContextType<typeof RuntimeAPIContext>}><div className="org-design">
    <div className="org-design-controls"><h1>会话导航 · 设计稿 01</h1><div className="org-design-modes" role="group" aria-label="预览模式">{([['workbench', '工作台', 'layout-grid'], ['bot', 'Bot', 'chat-3'], ['ide', 'IDE', 'code-box']] as const).map(([value, label, icon]) => <button key={value} type="button" aria-pressed={mode === value} className="org-design-mode" onClick={() => switchMode(value)}><Icon name={icon} className="size-3.5" />{label}</button>)}</div><span className="h-4 w-px bg-border" /><button type="button" className="org-icon-button" aria-label="切换窄窗口" aria-pressed={narrow} onClick={() => setNarrow(!narrow)}><Icon name="layout-column" className="size-4" /></button><button type="button" className="org-icon-button" aria-label="切换浅深主题" onClick={() => setThemeMode(currentTheme.metadata.variant === 'dark' ? 'light' : 'dark')}><Icon name="moon" className="size-4" /></button></div>
    <div className="org-design-stage"><div className="org-design-window" data-narrow={narrow}>
      <header className="org-titlebar"><VarinLogo width={17} height={17} decorative className="text-muted-foreground" /><span className="text-[11px]">{mode === 'workbench' ? '工作台' : mode === 'bot' ? 'Varin' : 'IDE'}</span><Icon name="arrow-down-s" className="size-3 text-muted-foreground" /><small>Varin</small></header>
      <div className="org-window-body" data-mode={mode}>
        <OrganizationNavigation mode={mode} folders={folders} items={items} active={sideWork ?? active} onSelect={select} onEdit={setEditor} onNew={start}
          onArchive={id => { setItems(current => current.map(item => item.id === id ? { ...item, archived: !item.archived } : item)); toast.message(items.find(item => item.id === id)?.archived ? '已恢复会话' : '已归档会话'); }}
          onPin={id => setItems(current => current.map(item => item.id === id ? { ...item, pinned: !item.pinned } : item))} onNotice={text => toast.message(text)} />
        {mode === 'ide' && <IdeEditor />}
        <ConversationCanvas key={item.id} item={item} path={path} onMove={() => setEditor({ kind: 'move', item })} />
        {mode === 'bot' && work && <BotWorkPreview key={work.id} item={work} path={folderPath(folders, work.parent).map(folder => folder.name).join(' / ')} children={items.filter(child => child.childOf === work.id)} onClose={() => setSideWork(null)} onChild={setSideWork} onOpen={() => { setMode('workbench'); setActive(work.id); setSideWork(null); }} />}
      </div>
    </div></div>
    <OrganizationDialogs editor={editor} folders={folders} onClose={() => setEditor(null)} onMove={move}
      onGroup={folder => setFolders(current => current.some(item => item.id === folder.id) ? current.map(item => item.id === folder.id ? folder : item) : [...current, folder])}
      onRename={(id, title) => setItems(current => current.map(item => item.id === id ? { ...item, title } : item))} />
    <Toaster position="bottom-center" />
  </div></RuntimeAPIContext.Provider>;
}
