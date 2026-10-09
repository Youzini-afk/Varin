import React from 'react';
import { agentScopeKey, type AgentMemoryNote, type AgentMemoryScope } from '@varin/protocol';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { AgentScopePicker } from './AgentScopePicker';
import { useAgentSettings } from './agentSettings';

export function AgentMemoryPage({ initialScope, scopes, embedded = false }: {
  initialScope?: AgentMemoryScope;
  scopes?: Array<{ scope: AgentMemoryScope; label: string }>;
  embedded?: boolean;
} = {}) {
  const { t } = useI18n();
  const settings = useAgentSettings();
  const [scope, setScope] = React.useState<AgentMemoryScope>(initialScope ?? { kind: 'global' });
  const [draft, setDraft] = React.useState<{ id?: number; content: string; scope: AgentMemoryScope; revision: number } | null>(null);
  const [query, setQuery] = React.useState('');
  const initialKind = initialScope?.kind ?? 'global';
  const initialId = initialScope && 'id' in initialScope ? initialScope.id : '';
  React.useEffect(() => {
    setDraft(null);
    setScope(initialKind === 'global' ? { kind: 'global' } : { kind: initialKind, id: initialId });
  }, [settings.runtime, initialKind, initialId]);
  const items = settings.catalog?.memories.filter(note => agentScopeKey(note.scope) === agentScopeKey(scope)
    && note.content.toLowerCase().includes(query.toLowerCase())) ?? [];
  const save = async () => {
    if (!draft || !settings.catalog) return;
    if (await settings.update('memory', draft)) setDraft(null);
  };
  const remove = async (note: AgentMemoryNote) => {
    if (!settings.catalog) return;
    await settings.update(`memory/${note.id}`, { revision: settings.catalog.revision }, 'DELETE');
  };
  const picker = (value: AgentMemoryScope, change: (scope: AgentMemoryScope) => void) => scopes
    ? <select aria-label={t('assistant.scope')} disabled={settings.busy} value={agentScopeKey(value)}
      onChange={event => { const selected = scopes.find(option => agentScopeKey(option.scope) === event.target.value); if (selected) change(selected.scope); }}
      className="w-full rounded-md border bg-background px-2 py-2 typography-meta">
      {scopes.map(option => <option key={agentScopeKey(option.scope)} value={agentScopeKey(option.scope)}>{option.label}</option>)}
    </select>
    : <AgentScopePicker scope={value} disabled={settings.busy} onChange={change} />;
  const content = <>
    {settings.error ? <div role="alert" className="mb-4 text-destructive">{settings.error}
      <Button variant="ghost" size="sm" onClick={() => void settings.load()}>{t('assistant.reload')}</Button></div> : null}
    <div className="grid gap-6 md:grid-cols-[170px_minmax(0,1fr)]">
      {picker(scope, next => {
        if (draft && !window.confirm(t('assistant.discard'))) return;
        setDraft(null); setScope(next);
      })}
      <div className="min-w-0 space-y-3">
        <div className="flex items-center gap-2">
          <input aria-label={t('assistant.search')} placeholder={t('assistant.search')} value={query}
            onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 typography-meta" />
          <Button size="sm" disabled={settings.busy || !!draft || !settings.catalog} onClick={() => setDraft({ content: '', scope, revision: settings.catalog!.revision })}>
            <Icon name="add" className="size-4" />{t('assistant.add')}
          </Button>
        </div>
        {draft ? <div className="space-y-3 rounded-lg border border-primary/40 p-3">
          <Textarea autoFocus value={draft.content} rows={6} aria-label={t('assistant.memory.content')}
            onChange={event => setDraft({ ...draft, content: event.target.value })} disabled={settings.busy} />
          <details><summary className="cursor-pointer typography-meta text-muted-foreground">{t('assistant.move')}</summary>
            <div className="mt-2 max-w-64">{picker(draft.scope, next => setDraft({ ...draft, scope: next }))}</div>
          </details>
          <div className="flex justify-end gap-2"><Button variant="ghost" disabled={settings.busy} onClick={() => setDraft(null)}>{t('assistant.cancel')}</Button>
            <Button disabled={settings.busy || !draft.content.trim()} onClick={() => void save()}>{t('assistant.save')}</Button></div>
        </div> : null}
        {!settings.catalog && !settings.error ? <p role="status">{t('common.loading')}</p> : null}
        {settings.catalog && !items.length && !draft ? <p className="py-10 text-center text-muted-foreground typography-meta">{t('assistant.memory.empty')}</p> : null}
        <div className="divide-y divide-border/60">{items.map(note => <article key={note.id} className="group py-4 first:pt-1">
          <div className="flex items-start gap-3"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-6">{note.content}</p>
            <div className="flex shrink-0"><Button variant="ghost" size="sm" aria-label={t('assistant.edit')} disabled={settings.busy || !!draft}
              onClick={() => setDraft({ id: note.id, content: note.content, scope: note.scope, revision: settings.catalog!.revision })}><Icon name="edit" className="size-4" /></Button>
              <Button variant="ghost" size="sm" aria-label={t('assistant.delete')} disabled={settings.busy || !!draft} onClick={() => void remove(note)}><Icon name="delete-bin" className="size-4" /></Button></div>
          </div>
          <details className="mt-1 typography-micro text-muted-foreground"><summary className="cursor-pointer">{t('assistant.source')}</summary>
            <p className="mt-1 break-all">{note.source?.label ?? '—'} · {new Date(note.updatedAt).toLocaleString()}{note.source?.sessionId ? ` · ${note.source.sessionId}` : ''}</p>
          </details>
        </article>)}</div>
      </div>
    </div>
  </>;
  return embedded ? content : <SettingsPageLayout title={t('assistant.memory.title')} description={t('assistant.memory.description')} showSaveStatus={false}>{content}</SettingsPageLayout>;
}
