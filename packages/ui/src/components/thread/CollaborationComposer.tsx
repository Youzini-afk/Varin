import React from 'react';
import { ThreadRequestError, getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import type { AttachmentSelection, MessageFeedEntry } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore, type ThreadDraft } from '@/stores/useThreadDraftStore';
import { useI18n } from '@/lib/i18n';
import type { CollaborationMember } from './collaborationFeed';
import { prepareThreadFiles, removeDraftFile, selectThreadFiles } from '@/lib/agent-runtime/fileAttachments';
import { composerFileSelections, removeComposerFile } from '@/components/chat/composer/submit/fileSelections';
import { ComposerSelectedFiles } from './ComposerSelectedFiles';
import { ThreadFileDrafts } from './ThreadAttachments';
import { CollaborationMemberMenu } from './CollaborationMemberMenu';

export type CollaborationTarget = ThreadIdentity;
export function CollaborationComposer({
  api,
  identity,
  draftKey,
  referenceScope,
  members,
  defaultTarget,
  direct,
  onSent,
  loadMembers,
  moreMembers,
  loadingMembers,
  memberError,
}: {
  api: ThreadsAPI;
  identity: ThreadIdentity;
  draftKey: string;
  referenceScope?: string;
  members: CollaborationMember[];
  defaultTarget?: CollaborationTarget;
  direct?: CollaborationTarget;
  onSent(): void;
  loadMembers(): void;
  moreMembers: boolean;
  loadingMembers?: boolean;
  memberError?: string;
}) {
  const { t } = useI18n();
  const draft = useThreadDraftStore((state) => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const patch = (value: Partial<ThreadDraft>) => useThreadDraftStore.getState().patch(draftKey, value);
  const collaboration = draft.collaboration;
  const afterCurrent = collaboration?.afterCurrent ?? false;
  const targets = direct ? [direct] : (collaboration?.targets ?? (defaultTarget ? [defaultTarget] : []));
  const pending = collaboration?.attempts?.some((attempt) => !attempt.receipt) ?? false;
  const busy = collaboration?.sending ?? false;
  const retained = Boolean(collaboration?.attempts);
  const memberName = (id: string) =>
    members.find((member) => member.threadId === id)?.name ||
    members.find((member) => member.threadId === id)?.agentId ||
    id;
  const editTargets = (next: CollaborationTarget[]) =>
    patch({ collaboration: { targets: next, reply: collaboration?.reply, afterCurrent } });
  const targetName = (target: CollaborationTarget) => {
    const branches = members.find((member) => member.threadId === target.threadId)?.detail?.branches ?? [];
    const ordinal = branches.findIndex((branch) => branch.branchId === target.branchId);
    return (
      memberName(target.threadId) +
      (branches.length > 1 && ordinal >= 0 ? ` · ${t('chat.family.branch')} ${ordinal + 1}` : '')
    );
  };
  const input = React.useRef<HTMLTextAreaElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [preparationError, setPreparationError] = React.useState<string>();
  const host = getRuntimeEndpointGeneration();
  const latestSource = React.useRef(referenceScope); latestSource.current = referenceScope;
  const addFiles = (files: File[]) => {
    const current = useThreadDraftStore.getState().drafts[draftKey]?.collaboration;
    if (!current?.attempts && !current?.sending) selectThreadFiles(draftKey, files);
  };
  const selected = (target: CollaborationTarget) =>
    targets.some((current) => current.threadId === target.threadId && current.branchId === target.branchId);
  const [recipientsOpen, setRecipientsOpen] = React.useState(false);
  const recipients = members
    .flatMap(member => (member.detail?.branches ?? []).map((branch, index) => ({ member, branch, index })))
    .filter(({ member, branch }) => member.threadId !== identity.threadId || branch.branchId !== identity.branchId
      || selected({ runtime: 'agent', threadId: member.threadId, branchId: branch.branchId }))
    .sort((a, b) => Number(a.member.threadId === identity.threadId) - Number(b.member.threadId === identity.threadId));
  const send = async () => {
    const current = useThreadDraftStore.getState().drafts[draftKey] ?? draft;
    if (current.collaboration?.sending || !api.messages || (!current.text.trim() && !current.files?.length && !current.selectedAttachments?.length) || !targets.length) return;
    patch({ collaboration: { ...current.collaboration, targets, sending: true } }); setPreparationError(undefined);
    let attachments: AttachmentSelection[] = [];
    try {
      if (!current.collaboration?.attempts) {
        composerFileSelections(current.selectedAttachments, latestSource.current ?? '');
        const uploaded = await prepareThreadFiles(api, identity, draftKey, current.files ?? []);
        // Paths belong to the caller's actual source, never the selected recipient's workspace.
        const selectedFiles = composerFileSelections(current.selectedAttachments, latestSource.current ?? '');
        attachments = [...uploaded.map(({ ref }) => ({ ref })), ...selectedFiles];
      }
    }
    catch (failure) { patch({ collaboration: { ...current.collaboration, targets, sending: false } }); setPreparationError(failure instanceof Error ? failure.message : String(failure)); return; }
    if (host !== getRuntimeEndpointGeneration()) { patch({ collaboration: { ...current.collaboration, targets, sending: false } }); return; }
    const attempts =
      current.collaboration?.attempts ??
      targets.map((target) => ({
        request: {
          key: crypto.randomUUID(),
          kind: 'request' as const,
          afterCurrent,
          text: current.text,
          attachments,
          targetThreadId: target.threadId,
          targetBranchId: target.branchId,
          ...(current.collaboration?.reply ? { replyTo: current.collaboration.reply.messageId } : {}),
        },
      }));
    patch({ collaboration: { targets, reply: current.collaboration?.reply, afterCurrent, attempts, sending: true } });
    const results = await Promise.all(
      attempts.map(async (attempt) => {
        if ('receipt' in attempt && attempt.receipt) return attempt;
        try {
          return { request: attempt.request, receipt: await api.messages!.send(identity, attempt.request) };
        } catch (failure) {
          return {
            request: attempt.request,
            error:
              failure instanceof ThreadRequestError && [400, 401, 403, 409, 413].includes(failure.status)
                ? t('chat.messages.notAccepted')
                : failure instanceof Error
                  ? failure.message
                  : t('chat.messages.unconfirmed'),
          };
        }
      }),
    );
    if (results.every((attempt) => 'receipt' in attempt && attempt.receipt)) {
      const latest = useThreadDraftStore.getState().drafts[draftKey];
      patch({ text: latest?.text === current.text ? '' : latest?.text ?? '', files: latest?.files?.filter(file => !current.files?.some(selected => selected.id === file.id)), selectedAttachments: latest?.selectedAttachments?.filter(file => !current.selectedAttachments?.some(selected => selected.id === file.id)), collaboration: { targets } });
    } else
      patch({ collaboration: { targets, reply: current.collaboration?.reply, afterCurrent, attempts: results, sending: false } });
    if (host === getRuntimeEndpointGeneration()) onSent();
  };
  const reply: MessageFeedEntry | undefined = collaboration?.reply;
  React.useEffect(() => {
    if (reply) input.current?.focus();
  }, [draftKey, reply]);
  return (
    <div className="collaboration-composer-wrap px-3 pb-3 pt-2">
      <div className="rounded-xl border border-border/70 bg-[var(--surface-elevated)] p-3"
        onDragOver={event => { if (!busy && !retained && [...event.dataTransfer.items].some(item => item.kind === 'file')) event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); addFiles([...event.dataTransfer.files]); }}>
        <input ref={fileInput} type="file" multiple hidden aria-label={t('chat.attachments.choose')} disabled={busy || retained}
          onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; addFiles(files); }} />
        <ThreadFileDrafts draftKey={draftKey} files={draft.files} locked={busy || retained} onRemove={id => removeDraftFile(draftKey, id)} />
        <ComposerSelectedFiles files={draft.selectedAttachments} locked={busy || retained} onRemove={id => removeComposerFile(draftKey, id)} />
        {preparationError && <p role="alert" className="typography-micro text-destructive">{preparationError}</p>}
        {reply && (
          <div className="mb-2 flex items-center gap-2 border-b border-border/50 pb-2 typography-micro text-muted-foreground">
            <Icon name="reply" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {reply.actor.kind === 'user' ? t('collaboration.you') : memberName(reply.senderThreadId)} ·{' '}
              {reply.codeExchangeOperationId ? t('collaboration.fileExchange') : reply.text}
            </span>
            <button
              type="button"
              disabled={retained}
              aria-label={t('chat.messages.clearReply')}
              onClick={() => patch({ collaboration: { targets } })}
            >
              <Icon name="close" className="size-4" />
            </button>
          </div>
        )}
        <div className="flex items-center gap-2 typography-micro text-muted-foreground">
          <span>{t('collaboration.to')}</span>
          {direct ? (
            <span className="min-w-0 truncate text-foreground">{memberName(direct.threadId)}</span>
          ) : (
            <DropdownMenu open={recipientsOpen} onOpenChange={setRecipientsOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={retained || Boolean(reply)}
                  className="flex min-w-0 items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary"
                  aria-label={t('collaboration.recipients')}
                >
                  <span className="truncate">
                    {targets.length ? targets.map(targetName).join('、') : t('chat.messages.choose')}
                  </span>
                  <Icon name="arrow-down-s" className="size-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <CollaborationMemberMenu align="start" side="top" open={recipientsOpen} count={recipients.length}
                more={moreMembers} loading={loadingMembers} error={memberError} loadMore={loadMembers}>
                {recipients.map(({ member, branch, index }) => {
                    const target: CollaborationTarget = {
                      runtime: 'agent',
                      threadId: member.threadId,
                      branchId: branch.branchId,
                    };
                    return (
                      <DropdownMenuItem
                        key={`${member.threadId}:${branch.branchId}`}
                        closeOnClick={false}
                        onClick={() =>
                          editTargets(
                            selected(target)
                              ? targets.filter(
                                  (old) => old.threadId !== target.threadId || old.branchId !== target.branchId,
                                )
                              : [...targets, target],
                          )
                        }
                      >
                        <AgentAvatar identity={member.threadId} avatar={member.avatar} role={member.lead ? 'lead' : undefined} size={23} />
                        <span className="min-w-0 flex-1 truncate">
                          {member.name || member.agentId}
                          {(member.detail?.branches.length ?? 0) > 1
                            ? ` · ${t('chat.family.branch')} ${index + 1}`
                            : ''}
                        </span>
                        {selected(target) && <Icon name="check" className="size-4" />}
                      </DropdownMenuItem>
                    );
                  })}
              </CollaborationMemberMenu>
            </DropdownMenu>
          )}
        </div>
        <Textarea
          simple
          ref={input}
          value={draft.text}
          disabled={busy || retained}
          onPaste={event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); addFiles(files); } }}
          rows={2}
          aria-label={t('chat.messages.text')}
          placeholder={t(direct ? 'collaboration.directPlaceholder' : 'collaboration.placeholder')}
          className="min-h-16 resize-none border-0 bg-transparent px-0 py-2 typography-meta shadow-none focus-visible:ring-0"
          onInput={(event) => patch({ text: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {collaboration?.attempts
          ?.filter((attempt) => attempt.error)
          .map((attempt) => (
            <p key={attempt.request.key} role="alert" className="mb-2 typography-micro text-destructive">
              {memberName(attempt.request.targetThreadId!)} · {attempt.error}
            </p>
          ))}
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy || retained} aria-label={t('chat.attachments.choose')} onClick={() => fileInput.current?.click()}><Icon name="attachment-2" className="size-4" /></button>
          <span className="flex-1 typography-micro text-muted-foreground">
            {t(direct ? 'collaboration.directHint' : 'collaboration.sendHint')}
          </span>
          {pending && (
            <button
              type="button"
              disabled={busy}
              className="typography-micro text-muted-foreground"
              onClick={() => patch({ text: '', files: [], selectedAttachments: [], collaboration: { targets } })}
            >
              {t('chat.messages.newDraft')}
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="collaboration-send-timing" disabled={busy || retained}
                aria-label={t('collaboration.queue.timing')} title={t(afterCurrent ? 'collaboration.queue.afterHint' : 'collaboration.queue.nowHint')}>
                <Icon name={afterCurrent ? 'time' : 'arrow-up'} className="size-3.5" />
                <span>{t(afterCurrent ? 'collaboration.queue.after' : 'collaboration.queue.now')}</span>
                <Icon name="arrow-down-s" className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              {[false, true].map(value => <DropdownMenuItem key={String(value)} onClick={() => patch({ collaboration: { ...collaboration, targets, afterCurrent: value } })}>
                <Icon name={value ? 'time' : 'arrow-up'} className="size-4" />
                <span>{t(value ? 'collaboration.queue.after' : 'collaboration.queue.now')}</span>
                {afterCurrent === value && <Icon name="check" className="ml-auto size-4" />}
              </DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            size="icon"
            className="size-7 rounded-lg"
            disabled={busy || (!draft.text.trim() && !draft.files?.length && !draft.selectedAttachments?.length) || !targets.length}
            onClick={() => void send()}
            aria-label={t(pending ? 'chat.messages.retry' : 'collaboration.send')}
          >
            <Icon name={busy ? 'more' : afterCurrent ? 'time' : 'arrow-up'} className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
