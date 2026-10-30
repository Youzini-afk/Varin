import React from 'react';
import { ThreadRequestError, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import type { MessageFeedEntry } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore, type ThreadDraft } from '@/stores/useThreadDraftStore';
import { useI18n } from '@/lib/i18n';
import type { CollaborationMember } from './collaborationFeed';

export type CollaborationTarget = ThreadIdentity;
export function CollaborationComposer({
  api,
  identity,
  draftKey,
  members,
  defaultTarget,
  direct,
  onSent,
  loadMembers,
  moreMembers,
}: {
  api: ThreadsAPI;
  identity: ThreadIdentity;
  draftKey: string;
  members: CollaborationMember[];
  defaultTarget?: CollaborationTarget;
  direct?: CollaborationTarget;
  onSent(): void;
  loadMembers(): void;
  moreMembers: boolean;
}) {
  const { t } = useI18n();
  const draft = useThreadDraftStore((state) => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const patch = (value: Partial<ThreadDraft>) => useThreadDraftStore.getState().patch(draftKey, value);
  const collaboration = draft.collaboration;
  const targets = direct ? [direct] : (collaboration?.targets ?? (defaultTarget ? [defaultTarget] : []));
  const pending = collaboration?.attempts?.some((attempt) => !attempt.receipt) ?? false;
  const busy = collaboration?.sending ?? false;
  const retained = Boolean(collaboration?.attempts);
  const memberName = (id: string) =>
    members.find((member) => member.threadId === id)?.name ||
    members.find((member) => member.threadId === id)?.agentId ||
    id;
  const editTargets = (next: CollaborationTarget[]) =>
    patch({ collaboration: { targets: next, reply: collaboration?.reply } });
  const targetName = (target: CollaborationTarget) => {
    const branches = members.find((member) => member.threadId === target.threadId)?.detail?.branches ?? [];
    const ordinal = branches.findIndex((branch) => branch.branchId === target.branchId);
    return (
      memberName(target.threadId) +
      (branches.length > 1 && ordinal >= 0 ? ` · ${t('chat.family.branch')} ${ordinal + 1}` : '')
    );
  };
  const input = React.useRef<HTMLTextAreaElement>(null);
  const selected = (target: CollaborationTarget) =>
    targets.some((current) => current.threadId === target.threadId && current.branchId === target.branchId);
  const send = async () => {
    const current = useThreadDraftStore.getState().drafts[draftKey] ?? draft;
    if (current.collaboration?.sending || !api.messages || !current.text.trim() || !targets.length) return;
    const attempts =
      current.collaboration?.attempts ??
      targets.map((target) => ({
        request: {
          key: crypto.randomUUID(),
          kind: 'request' as const,
          text: current.text,
          targetThreadId: target.threadId,
          targetBranchId: target.branchId,
          ...(current.collaboration?.reply ? { replyTo: current.collaboration.reply.messageId } : {}),
        },
      }));
    patch({ collaboration: { targets, reply: current.collaboration?.reply, attempts, sending: true } });
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
      patch({ text: '', collaboration: { targets } });
    } else
      patch({ collaboration: { targets, reply: current.collaboration?.reply, attempts: results, sending: false } });
    onSent();
  };
  const reply: MessageFeedEntry | undefined = collaboration?.reply;
  React.useEffect(() => {
    if (reply) input.current?.focus();
  }, [draftKey, reply]);
  return (
    <div className="collaboration-composer-wrap px-3 pb-3 pt-2">
      <div className="rounded-xl border border-border/70 bg-[var(--surface-elevated)] p-3">
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
            <DropdownMenu>
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
              <DropdownMenuContent align="start" side="top" className="max-h-80 w-64 overflow-y-auto">
                {members.flatMap((member) =>
                  (member.detail?.branches ?? []).map((branch, index) => {
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
                  }),
                )}
                {moreMembers && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem closeOnClick={false} onClick={loadMembers}>
                      {t('collaboration.moreMembers')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <Textarea
          simple
          ref={input}
          value={draft.text}
          disabled={retained}
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
          <span className="flex-1 typography-micro text-muted-foreground">
            {t(direct ? 'collaboration.directHint' : 'collaboration.sendHint')}
          </span>
          {pending && (
            <button
              type="button"
              disabled={busy}
              className="typography-micro text-muted-foreground"
              onClick={() => patch({ text: '', collaboration: { targets } })}
            >
              {t('chat.messages.newDraft')}
            </button>
          )}
          <Button
            type="button"
            size="icon"
            className="size-7 rounded-lg"
            disabled={busy || !draft.text.trim() || !targets.length}
            onClick={() => void send()}
            aria-label={t(pending ? 'chat.messages.retry' : 'collaboration.send')}
          >
            <Icon name={busy ? 'more' : 'arrow-up'} className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
