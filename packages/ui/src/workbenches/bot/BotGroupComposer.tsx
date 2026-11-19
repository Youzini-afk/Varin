import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { AnimatePresence, motion } from 'motion/react';
import type { BotGroupMember, BotSummary } from '@varin/application-client';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { Icon } from '@/components/icon/Icon';
import { SwapText } from '@/components/motion/SwapText';
import { ThreadFileDrafts } from '@/components/thread/ThreadAttachments';
import { ThreadComposer } from '@/components/thread/ThreadComposer';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { springTransition } from '@/lib/motion/tokens';
import { GroupAvatar, GroupAvatarStack } from './GroupAvatar';
import { groupLabel as L, groupDraftRecipients, placeGroupMention, type GroupDraft, type GroupDraftFile, type GroupQuote } from './botGroupChatModel';

export function BotGroupComposer({ groupId, editor, draft, onDraft, quote, onClearQuote, members, bots, displayName, files, onFiles, onRemoveFile, busy, onSend, onWake }: {
  groupId: string; editor: React.RefObject<ComposerEditorHandle | null>; draft: GroupDraft; onDraft(draft: GroupDraft): void;
  quote?: GroupQuote; onClearQuote(): void; members: BotGroupMember[]; bots: BotSummary[]; displayName(id: string): string;
  files: GroupDraftFile[]; onFiles(files: File[]): void; onRemoveFile(id: string): void; busy: boolean; onSend(): void; onWake(bot: BotSummary): void;
}) {
  const fileInput = React.useRef<HTMLInputElement>(null);
  const imageInput = React.useRef<HTMLInputElement>(null);
  const reduced = usePrefersReducedMotion();
  const { addressed, replyId, listeners, recipients, gone } = groupDraftRecipients(draft, members, quote);
  const sleeping = bots.filter(bot => recipients.includes(bot.id) && bot.activity?.state === 'asleep');
  const quoteAuthor = quote?.post.author.kind === 'bot' ? quote.post.author.name : undefined;
  const reply = Boolean(quote && replyId && recipients.includes(replyId));
  const recipientNames = recipients.map(displayName).join('、');
  const routeReason = addressed.length ? undefined : replyId ? L('reply') : listeners.length ? L('listening') : undefined;
  const hasInput = Boolean(draft.text.trim() || files.length);
  const changeFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = '';
  };
  const removeMention = (id: string) => {
    const input = editor.current;
    if (!input) return;
    const text = input.getValue();
    const matches = draft.references.filter(ref => ref.target.kind === 'group-member' && ref.target.botId === id);
    for (const ref of [...matches].reverse()) input.replaceRange(ref.from, ref.to + Number(text[ref.to] === ' '), '');
  };
  const toggleRecipient = (id: string) => {
    if (addressed.includes(id)) { removeMention(id); return; }
    if (addressed.length) { placeGroupMention(editor.current, id, displayName(id)); return; }
    const next = recipients.includes(id) ? recipients.filter(value => value !== id) : [...recipients, id];
    for (const value of [...next].reverse()) placeGroupMention(editor.current, value, displayName(value));
  };
  const deliveryControl = <Popover.Root>
    <Popover.Trigger disabled={busy} className="group-chat-recipient"
      aria-label={gone.length ? L('left') : recipients.length ? `${L('to')} ${recipientNames}` : L('record')} data-unavailable={gone.length > 0 || undefined}>
      {gone.length ? <Icon name="error-warning" className="size-3.5 shrink-0" /> : recipients.length
        ? <GroupAvatarStack ids={recipients.slice(0, 3)} bots={bots} displayName={displayName} size={17} />
        : <Icon name="file-text" className="size-3.5 shrink-0" />}
      <span className="min-w-0 truncate"><SwapText text={gone.length ? L('left') : recipients.length ? `${L('to')} ${recipientNames}` : L('record')} hold={0} /></span>
      {routeReason && <span className="group-chat-recipient-reason">· {routeReason}</span>}
      <Icon name="arrow-down-s" className="size-3 shrink-0" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner className="z-50" side="top" align="end" sideOffset={7}>
        <Popover.Popup className="group-chat-recipient-popup">
          <Popover.Title className="group-chat-recipient-title">{L('to')}</Popover.Title>
          <div className="group-chat-recipient-list">
            {members.map(member => {
              const checked = recipients.includes(member.botId);
              const implicitOnly = checked && !addressed.length && recipients.length === 1;
              return <label key={member.membership} className="group-chat-recipient-option" title={implicitOnly ? L('routeRequired') : undefined}>
                <input type="checkbox" checked={checked} disabled={implicitOnly} onChange={() => toggleRecipient(member.botId)} />
                <GroupAvatar bot={bots.find(bot => bot.id === member.botId)} name={displayName(member.botId)} size={24} />
                <span className="min-w-0 flex-1 truncate">{displayName(member.botId)}</span>
                <small>{checked ? addressed.length ? L('mentioned') : routeReason
                  : member.botId === replyId ? L('quotedOnly') : member.listening ? L('listeningSkipped') : null}</small>
              </label>;
            })}
          </div>
          {!recipients.length && <Popover.Description className="group-chat-recipient-note">{L('recordHint')}</Popover.Description>}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
  const draftAttachments = React.useMemo(() => files.map(({ id, file }) => ({
    id, filename: file.name, mimeType: file.type, data: file, status: 'selected' as const,
  })), [files]);
  return <form className="group-chat-composer" onSubmit={event => { event.preventDefault(); onSend(); }}>
    <input ref={fileInput} type="file" multiple hidden onChange={changeFiles} />
    <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={changeFiles} />
    <ThreadComposer editorRef={editor} value={draft.text} references={draft.references} referenceScope={groupId}
      onChange={(text, references) => onDraft({ text, references: references ?? [] })}
      models={[]} providerId="" modelId="" thinkingLevel="off" onModelChange={() => {}} modelDisabled
      attachmentDisabled={busy} imageDisabled={busy} sendDisabled={busy || Boolean(gone.length) || !hasInput} pending={busy} active={false} retrying={false}
      onFiles={onFiles} onAttachImages={() => imageInput.current?.click()} onAttachPdfs={() => fileInput.current?.click()}
      hasInput={hasInput} workspaceLabel="" skills={[]} attachmentNames={draftAttachments.map(file => file.filename)}
      groupDelivery={{ control: deliveryControl, placeholder: listeners.length ? L('write') : L('mentionPlaceholder'), mentionLabel: L('mention'),
        members: members.map(member => ({ id: member.botId, group: L('members'), label: displayName(member.botId),
          description: member.listening ? L('listening') : undefined,
          icon: <GroupAvatar bot={bots.find(bot => bot.id === member.botId)} name={displayName(member.botId)} size={23} /> })),
      }}>
      <AnimatePresence initial={false}>
        {quote && <motion.div className="group-chat-composer-strip" key="quote" initial={reduced ? false : { opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0 }} transition={springTransition('settle')}>
          <Icon name={reply ? 'reply' : 'chat-quote'} className="size-3.5 shrink-0" />
          <SwapText text={[L(reply ? 'reply' : 'quote'), quoteAuthor].filter(Boolean).join(' ')} hold={0} />
          <span className="min-w-0 flex-1 truncate">{quote.post.text}</span>
          <button type="button" className="group-chat-strip-close" disabled={busy} onClick={onClearQuote} aria-label={L('cancel')}><Icon name="close" className="size-3.5" /></button>
        </motion.div>}
      </AnimatePresence>
      {gone.map(id => <div key={id} className="group-chat-composer-strip" data-warning="true">
        <Icon name="error-warning" className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">@{displayName(id)} · {L('left')}</span>
        <button type="button" className="group-chat-strip-close" onClick={() => removeMention(id)} aria-label={`${L('remove')} @${displayName(id)}`}><Icon name="close" className="size-3.5" /></button>
      </div>)}
      {sleeping.map(bot => <div key={bot.id} className="group-chat-composer-strip">
        <Icon name="moon" className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate" title={L('awakeToReceive')}>{bot.name} · {L('asleep')}</span>
        <button type="button" className="group-chat-strip-close" onClick={() => onWake(bot)}>{L('wake')}</button>
      </div>)}
      {files.length > 0 && <div className="px-3 pt-2"><ThreadFileDrafts files={draftAttachments} locked={busy} onRemove={onRemoveFile} /></div>}
    </ThreadComposer>
  </form>;
}
