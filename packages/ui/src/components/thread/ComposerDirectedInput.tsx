import React from 'react';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { directedComposerKey, type ComposerRecipient } from './composerWorkflowState';
import { ComposerRecipientPicker } from './ComposerRecipientPicker';
import { CollaborationComposer } from './CollaborationComposer';

export function ComposerDirectedInput({ api, identity, draftKey, recipient, select, onSent }: { api: ThreadsAPI; identity: ThreadIdentity; draftKey: string; recipient: ComposerRecipient; select(recipient?: ComposerRecipient): void; onSent(): void }) {
  const { t } = useI18n(), [picking, setPicking] = React.useState(false);
  const key = directedComposerKey(draftKey, recipient.identity);
  const draft = useThreadDraftStore(state => state.drafts[key]);
  const copy = () => {
    const store = useThreadDraftStore.getState(), original = store.drafts[draftKey];
    if (!original?.text || draft?.collaboration?.attempts || draft?.collaboration?.sending) return;
    store.patch(key, current => ({ text: [current.text, original.text].filter(Boolean).join('\n\n') }));
  };
  return <section aria-label={t('composer.sendingTo', { name: recipient.name })} className="border-t border-border/50">
    <div className="flex flex-wrap items-center gap-2 px-3 pt-2 typography-ui-label"><strong className="min-w-0 flex-1 truncate">{t('composer.sendingTo', { name: recipient.name })}</strong>
      <Button type="button" size="sm" variant="ghost" onClick={() => setPicking(value => !value)}>{t('composer.workflow.changeRecipient')}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => select()}>{t('composer.contact.cancel')}</Button>
    </div>
    {picking && <div className="p-3"><ComposerRecipientPicker api={api} identity={identity} onSelect={next => { select(next); setPicking(false); }} /></div>}
    <div className="px-3 pt-1"><Button type="button" size="sm" variant="ghost" disabled={Boolean(draft?.collaboration?.attempts || draft?.collaboration?.sending)} onClick={copy}>{t('composer.workflow.copyConversationText')}</Button></div>
    <CollaborationComposer key={key} api={api} identity={identity} draftKey={key} direct={recipient.identity} members={[{ threadId: recipient.identity.threadId, name: recipient.name, agentId: '', avatar: recipient.avatar ?? null }]} onSent={onSent} loadMembers={() => {}} moreMembers={false} />
  </section>;
}
