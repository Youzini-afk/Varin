import React from 'react';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { agentScopeKey, type AgentMemoryNote, type AgentMemoryScope } from '@varin/protocol';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { AgentScopePicker } from './AgentScopePicker';
import { useAgentSettings } from './agentSettings';

export function AgentMemoryPage({ initialScope, scopes, embedded = false, onContentChange }: {
  initialScope?: AgentMemoryScope;
  scopes?: Array<{ scope: AgentMemoryScope; label: string }>;
  embedded?: boolean;
  onContentChange?(present: boolean): void;
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
    && (note.id === draft?.id || note.content.toLowerCase().includes(query.toLowerCase()))) ?? [];
  const hasContent = Boolean(draft || settings.error || settings.catalog?.memories.some(note =>
    !scopes || scopes.some(option => agentScopeKey(option.scope) === agentScopeKey(note.scope))));
  React.useEffect(() => { onContentChange?.(hasContent); }, [hasContent, onContentChange]);
  const save = async () => {
    if (!draft || !settings.catalog) return false;
    const saved = await settings.update('memory', draft);
    if (saved) setDraft(null);
    return saved;
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
  const editor = draft ? <div className="settings-memory-editor space-y-3 py-2">
          <Textarea autoFocus value={draft.content} rows={8} className="min-h-48 max-h-[60vh] resize-y bg-transparent leading-relaxed" aria-label={t('assistant.memory.content')}
            onChange={event => setDraft({ ...draft, content: event.target.value })} disabled={settings.busy} />
          <SettingsDisclosure title={t('assistant.move')}>
            <div className="mt-2 max-w-64">{picker(draft.scope, next => setDraft({ ...draft, scope: next }))}</div>
          </SettingsDisclosure>
          <SettingsActionBar placement="inline" saveLabel={t('assistant.save')} dirty={true} saving={settings.busy} saveDisabled={!draft.content.trim()} onSave={save} onCancel={() => setDraft(null)} error={settings.error} />
        </div> : null;
  const content = <>
    {settings.error ? <div role="alert" className="mb-4 text-destructive">{settings.error}
      <Button variant="ghost" size="sm" onClick={() => void settings.load()}>{t('assistant.reload')}</Button></div> : null}
    <div className="space-y-5">
      <div className="max-w-72">{picker(scope, next => {
        requestSettingsNavigation(() => { setDraft(null); setScope(next); });
      })}</div>
      <div className="min-w-0 space-y-3">
        <div className="flex items-center gap-2">
          <input aria-label={t('assistant.search')} placeholder={t('assistant.search')} value={query}
            onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 typography-meta" />
          <Button size="sm" disabled={settings.busy || !!draft || !settings.catalog} onClick={() => setDraft({ content: '', scope, revision: settings.catalog!.revision })}>
            <Icon name="add" className="size-4" />{t('assistant.add')}
          </Button>
        </div>
        {draft && draft.id === undefined ? editor : null}
        {!settings.catalog && !settings.error ? <p role="status">{t('common.loading')}</p> : null}
        {settings.catalog && !items.length && !draft ? <p className="py-10 text-center text-muted-foreground typography-meta">{t('assistant.memory.empty')}</p> : null}
        <div className="divide-y divide-border/60">{items.map(note => <article key={note.id} className="group py-4 first:pt-1">
          {draft?.id === note.id ? editor : <div className="flex items-start gap-3"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-6">{note.content}</p>
            <div className="flex shrink-0"><Button variant="ghost" size="sm" aria-label={t('assistant.edit')} disabled={settings.busy || !!draft}
              onClick={() => setDraft({ id: note.id, content: note.content, scope: note.scope, revision: settings.catalog!.revision })}><Icon name="edit" className="size-4" /></Button>
              <Button variant="ghost" size="sm" aria-label={t('assistant.delete')} disabled={settings.busy || !!draft} onClick={() => void remove(note)}><Icon name="delete-bin" className="size-4" /></Button></div>
          </div>}
          <details className="mt-1 typography-micro text-muted-foreground"><summary className="cursor-pointer">{t('assistant.source')}</summary>
            <p className="mt-1 break-all">{note.source?.label ?? '—'} · {new Date(note.updatedAt).toLocaleString()}{note.source?.threadId ? ` · ${note.source.threadId}` : ''}</p>
          </details>
        </article>)}</div>
      </div>
    </div>
  </>;
  return embedded ? content : <SettingsPageLayout title={t('assistant.memory.title')} description={t('assistant.memory.description')} showSaveStatus={false}>{content}</SettingsPageLayout>;
}
