import React from 'react';
import { composerWorkflowFailure } from './composerWorkflowState';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import type { FamilyMember } from '@varin/protocol';
import { ChildState } from '@/components/conversation/childPresentation';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { ComposerRecipient } from './composerWorkflowState';

/** Real family directory, not agent presets. Branch identity remains separate from the display name. */
export function ComposerRecipientPicker({ api, identity, onSelect }: { api: ThreadsAPI; identity: ThreadIdentity; onSelect(target: ComposerRecipient): void }) {
  const { t } = useI18n();
  const [host] = React.useState(getRuntimeEndpointGeneration), [query, setQuery] = React.useState('');
  const [members, setMembers] = React.useState<FamilyMember[]>([]), [cursor, setCursor] = React.useState<string | null>();
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string>();
  const pending = React.useRef<AbortController | null>(null);
  const load = React.useCallback(async (next?: string) => {
    if (!api.family || host !== getRuntimeEndpointGeneration()) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; setBusy(true); setError(undefined);
    try {
      const page = await api.family.list({ runtime: 'agent', threadId: identity.threadId, branchId: identity.branchId }, { includeSelf: false, query, ...(next ? { cursor: next } : {}) }, controller.signal);
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      setMembers(old => next ? [...old.filter(member => !page.members.some(value => value.threadId === member.threadId)), ...page.members] : page.members); setCursor(page.nextCursor ?? null);
    } catch (cause) { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(composerWorkflowFailure(cause)); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }, [api, host, identity.threadId, identity.branchId, query]);
  React.useEffect(() => { void load(); return () => pending.current?.abort(); }, [load]);
  return <div className="space-y-2 typography-ui-label">
    <input autoFocus aria-label={t('composer.workflow.findRecipient')} value={query} onChange={event => setQuery(event.target.value)} className="w-full rounded border bg-background p-2" />
    <p className="text-muted-foreground">{t('composer.workflow.recipientIdentity')}</p>
    {error && <p role="alert" className="text-destructive">{error}<button type="button" onClick={() => void load()}>{t('composer.menu.retry')}</button></p>}
    <div className="max-h-64 space-y-1 overflow-y-auto">{members.flatMap(member => member.branches.map((branch, index) => {
      const name = member.name || member.task || member.agentId || member.threadId;
      return <button type="button" key={`${member.threadId}:${branch.branchId}`} disabled={busy} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-accent focus-visible:ring-2"
        onClick={() => { if (host === getRuntimeEndpointGeneration()) onSelect({ identity: { runtime: 'agent', threadId: member.threadId, branchId: branch.branchId }, name: `${name}${member.branches.length > 1 ? ` · ${index + 1}` : ''}`, avatar: member.avatar }); }}>
        <AgentAvatar identity={member.threadId} avatar={member.avatar} size={24} /><span className="min-w-0 flex-1"><span className="block truncate">{name}</span><span className="block truncate typography-micro text-muted-foreground"><ChildState state={member.state} /> · {member.threadId} · {branch.branchId}</span></span>
      </button>;
    }))}</div>
    {busy && <p role="status">{t('common.loading')}</p>}{!busy && !members.length && !error && <p>{t('composer.workflow.noRecipients')}</p>}
    {cursor && <Button type="button" variant="ghost" disabled={busy} onClick={() => void load(cursor)}>{t('composer.menu.more')}</Button>}
  </div>;
}
