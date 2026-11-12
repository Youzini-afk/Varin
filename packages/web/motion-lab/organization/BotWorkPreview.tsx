import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { BotPortrait } from './Navigation';
import type { Conversation } from './data';

/** Same detail structure as BotWorkDetail, with its content supplied by this local scene. */
export function BotWorkPreview({ item, path, children, onClose, onOpen, onChild }: {
  item: Conversation; path: string; children: Conversation[]; onClose(): void; onOpen(): void; onChild(id: string): void;
}) {
  const [text, setText] = React.useState('');
  const [sent, setSent] = React.useState(false);
  return <aside className="org-bot-work flex min-h-0 w-[322px] shrink-0 flex-col border-l border-border bg-sidebar" aria-label="派发工作详情">
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 text-[11px] text-muted-foreground"><Icon name="task" className="size-3.5" />工作详情<button type="button" aria-label="关闭工作详情" className="org-icon-button ml-auto" onClick={onClose}><Icon name="close" className="size-3.5" /></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <AgentAvatar identity={item.id} size={36} role="lead" />
      <h2 className="mt-3 text-[15px] font-medium leading-6">{item.title}</h2>
      <p className="mt-1 break-words text-[10px] leading-5 text-muted-foreground">{path}</p>
      <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="bot-ring" /><span>{item.state === 'waiting' ? '需要你确认' : '正在执行'}</span><span className="ml-auto inline-flex items-center gap-1"><BotPortrait size={15} />Varin 派发</span></div>
      <div className="mt-6 border-t border-border pt-4"><h3 className="text-[11px] text-muted-foreground">最近进展</h3><p className="mt-2 text-[13px] leading-6">正在核对桌面安装与远程工作区。已有结果留在原任务中，Windows 安装流程有一项等待确认。</p></div>
      {children.length > 0 && <div className="mt-6"><h3 className="mb-2 text-[11px] text-muted-foreground">子任务</h3>{children.map(child => <button key={child.id} type="button" className="flex w-full items-start gap-2 rounded-lg px-1 py-2 text-left hover:bg-interactive-hover" onClick={() => onChild(child.id)}><AgentAvatar identity={child.id} size={20} /><span className="min-w-0 flex-1"><span className="block text-[12px] leading-5">{child.title}</span><span className="text-[10px] text-[var(--status-warning)]">需要你确认</span></span><Icon name="arrow-right-s" className="mt-1 size-3 text-muted-foreground" /></button>)}</div>}
    </div>
    <footer className="space-y-3 border-t border-border px-4 py-4"><Textarea rows={2} className="resize-none text-xs" aria-label="补充任务要求" placeholder="补充要求或回复这个任务…" value={text} onChange={event => { setText(event.target.value); setSent(false); }} /><div className="flex items-center gap-2"><Button type="button" size="sm" variant="ghost" onClick={onOpen}><Icon name="external-link" className="mr-1 size-3.5" />查看完整过程</Button><Button type="button" size="sm" className="ml-auto" disabled={!text.trim()} onClick={() => { setText(''); setSent(true); }}>发送</Button></div>{sent && <p role="status" className="text-[10px] text-muted-foreground">已添加到本页的交互预览</p>}</footer>
  </aside>;
}
