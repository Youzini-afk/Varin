import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import type { ChildTask } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { useThreadStore } from '@/stores/useThreadStore';
import { useI18n } from '@/lib/i18n';
import { childEnded } from './childTaskRows';

type MessageRequest = Parameters<NonNullable<ThreadsAPI['messages']>['send']>[1];

/** Both menu triggers use the same actions; mutations retain the existing Thread/message owners. */
export function ChildTaskMenu({ api, identity, child, name, task, state, expanded, stopping, pending, readOnly,
  onToggle, onChanged, onError, cancel, children }: {
  api: ThreadsAPI; identity: ThreadIdentity; child: ChildTask; name: string; task: string; state: string;
  expanded: boolean; stopping: boolean; pending: boolean; readOnly: boolean;
  onToggle(): void; onChanged(): Promise<void>; onError(error: string): void;
  cancel?: (operationId: string) => Promise<unknown>;
  children(menuButton: React.ReactNode): React.ReactElement;
}) {
  const { t } = useI18n();
  const [dialog, setDialog] = React.useState<'rename' | 'instruction'>();
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const inFlight = React.useRef(false);
  const alive = React.useRef(true);
  const messageAttempt = React.useRef<MessageRequest | undefined>(undefined);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const ended = childEnded(state);
  const instructionLabel = t(ended ? 'chat.children.continueTask' : 'chat.children.addInstruction');
  const openDialog = (mode: 'rename' | 'instruction') => {
    setError(''); setValue(mode === 'rename' ? name : ''); setDialog(mode); messageAttempt.current = undefined;
  };
  const action = async (work: () => Promise<unknown>) => {
    try { await work(); }
    catch (failure) { if (alive.current) onError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dialog || readOnly || inFlight.current || !value.trim()) return;
    const host = getRuntimeEndpointGeneration();
    const current = () => alive.current && host === getRuntimeEndpointGeneration();
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (dialog === 'rename') {
        await useThreadStore.getState().resolveThread({ threadId: child.child_thread_id });
        if (!current()) return;
        await useThreadStore.getState().updateThread(child.child_thread_id, { title: value.trim() });
      } else {
        if (!api.messages) return;
        if (messageAttempt.current?.text !== value) messageAttempt.current = {
          key: crypto.randomUUID(), kind: 'request', text: value,
          targetThreadId: child.child_thread_id, targetBranchId: child.child_branch_id,
        };
        await api.messages.send(identity, messageAttempt.current);
      }
      if (!current()) return;
      if (dialog === 'instruction') toast.success(t('chat.children.instructionSent'));
      messageAttempt.current = undefined; setDialog(undefined);
      // A failed refresh must not turn an accepted mutation into a new send.
      await action(onChanged);
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  };
  const menu = (Item: typeof ContextMenuItem, Separator: typeof ContextMenuSeparator) => <>
    <div className="flex max-w-64 items-center gap-2 px-2 py-2">
      <AgentAvatar identity={child.child_thread_id} avatar={child.avatar} size={28} />
      <div className="min-w-0"><p className="break-words typography-meta font-medium">{name}</p>
        {child.agent_id && <p className="typography-micro font-mono text-muted-foreground">{child.agent_id}</p>}</div>
    </div>
    <Separator />
    <Item onClick={() => void action(() => openThreadFromNavigation({ threadId: child.child_thread_id, branchId: child.child_branch_id }))}>
      <Icon name="chat-1" className="size-4" />{t('harness.threads.openConversation')}
    </Item>
    <Item onClick={onToggle}><Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4" />{t(expanded ? 'chat.children.collapseDetails' : 'chat.children.expandDetails')}</Item>
    {!readOnly && <>
      <Separator />
      {api.messages && <Item disabled={pending || busy} onClick={() => openDialog('instruction')}><Icon name="chat-new" className="size-4" />{instructionLabel}</Item>}
      <Item disabled={pending || busy} onClick={() => openDialog('rename')}><Icon name="edit" className="size-4" />{t('chat.children.rename')}</Item>
    </>}
    <Separator />
    <Item onClick={() => void action(() => navigator.clipboard.writeText(task))}><Icon name="file-copy" className="size-4" />{t('chat.children.copyTask')}</Item>
    <Item onClick={() => void action(() => navigator.clipboard.writeText(child.agent_id || child.child_thread_id))}><Icon name="file-copy" className="size-4" />{t('chat.children.copyId')}</Item>
    {!readOnly && cancel && !ended && <>
      <Separator />
      <Item data-variant="destructive" disabled={pending || stopping || busy} onClick={() => void action(() => cancel(child.operation_id))}>
        <Icon name="stop-circle" className="size-4" />{t(stopping ? 'chat.children.stopping' : 'harness.threads.stop')}
      </Item>
    </>}
  </>;
  const menuButton = <DropdownMenu>
    <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={t('chat.children.actions')}
      className="size-6 shrink-0 text-muted-foreground opacity-100 sm:opacity-0 sm:group-hover/child:opacity-100 sm:group-focus-within/child:opacity-100 data-[popup-open]:opacity-100"
      onClick={event => event.stopPropagation()}><Icon name="more" className="size-4" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">{menu(DropdownMenuItem, DropdownMenuSeparator)}</DropdownMenuContent>
  </DropdownMenu>;
  return <>
    <ContextMenu><ContextMenuTrigger asChild>{children(menuButton)}</ContextMenuTrigger>
      <ContextMenuContent>{menu(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
    </ContextMenu>
    <Dialog open={Boolean(dialog)} onOpenChange={open => { if (!open) setDialog(undefined); }}>
      <DialogContent><form className="space-y-4" onSubmit={event => void save(event)}>
        <DialogHeader><DialogTitle>{dialog === 'rename' ? t('chat.children.rename') : instructionLabel}</DialogTitle>
          <DialogDescription>{name}</DialogDescription></DialogHeader>
        {dialog === 'rename' ? <Input autoFocus aria-label={t('chat.children.taskName')} value={value} disabled={busy} onChange={event => setValue(event.target.value)} />
          : <Textarea autoFocus aria-label={t('chat.children.instruction')} value={value} disabled={busy} className="min-h-28" onChange={event => setValue(event.target.value)} />}
        {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setDialog(undefined)}>{t('sessions.sidebar.dialogs.cancel')}</Button>
          <Button type="submit" disabled={busy || !value.trim()}>{t(dialog === 'rename' ? 'settings.common.actions.saveChanges' : 'chat.children.sendInstruction')}</Button></DialogFooter>
      </form></DialogContent>
    </Dialog>
  </>;
}
