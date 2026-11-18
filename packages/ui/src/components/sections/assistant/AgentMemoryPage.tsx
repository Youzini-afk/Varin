import React from 'react';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { agentScopeKey, type AgentMemoryNote, type AgentMemoryScope } from '@varin/protocol';
import { useThreadStore } from '@/stores/useThreadStore';
import { Textarea } from '@/components/ui/textarea';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { useI18n } from '@/lib/i18n';
import { AgentScopePicker } from './AgentScopePicker';
import { useAgentSettings } from './agentSettings';
import { EmbeddingRequests } from '../harness/EmbeddingSettings';
import { LocalSemanticSettings } from '../harness/LocalSemanticSettings';
import { useHarnessSettings } from '../harness/useHarnessSettings';
import { useConfigurationModels } from '../harness/ConfigurationModels';
import { Btn, Disclosure, Empty, Field, Loading, Note, Page, Row, Section, Select, useSettingsShell, type SelectItem } from '../shared/kit';
import { SettingsScopeLabel } from '../shared/SettingsScope';

function MemoryRetrievalSettings() {
  const { t } = useI18n();
  const shell = useSettingsShell();
  const { harness, update, error, retry, targetKey } = useHarnessSettings();
  const { providers, modelsFor, error: catalogError } = useConfigurationModels();
  const binding = harness?.embedding;
  const modelKey = (providerId: string, modelId: string) => JSON.stringify([providerId, modelId]);
  const selected = binding?.protocol === 'local' ? 'local' : binding ? modelKey(binding.providerId, binding.modelId) : 'off';
  const options: SelectItem<string>[] = [
    { value: 'off', label: t('settings.page.harness.embeddings.off') },
    { value: 'local', icon: 'computer', label: t('settings.page.harness.localSemantic.source') },
  ];
  const available = new Map<string, { providerId: string; modelId: string }>();
  for (const provider of providers) {
    const models = modelsFor(provider.id, 'embedding');
    if (!models.length) continue;
    options.push({ group: provider.name || provider.id, key: provider.id });
    for (const model of models) {
      const value = modelKey(provider.id, model.id);
      const label = model.name || model.id;
      available.set(value, { providerId: provider.id, modelId: model.id });
      options.push({ value, label, text: label, logo: <ModelLogo className="size-3.5" modelId={model.id} requestModelId={model.requestModelId} displayName={label} /> });
    }
  }
  if (binding && binding.protocol !== 'local' && !available.has(selected)) {
    options.splice(2, 0, { value: selected, label: binding.modelId, disabled: true,
      logo: <ModelLogo className="size-3.5" modelId={binding.modelId} /> });
  }
  const label = t('settings.memoryx.embedding');
  const model = <>
    <Row label={label} item="harness.embedding" description={t('settings.memoryx.embeddingHint')}>
      <Select value={harness ? selected : null} options={options} disabled={!harness} width="wl" label={label} placeholder={t('common.loading')}
        onChange={value => {
          if (value === 'off') update({ embedding: undefined });
          else if (value === 'local') update({ embedding: { protocol: 'local', providerId: 'local', modelId: 'installed', dimensions: undefined, maxTokens: undefined } });
          else {
            const next = available.get(value);
            if (next) update({ embedding: { protocol: 'openai-compatible', ...next } });
          }
        }}
        footer={close => <Btn kind="ghost" sm onClick={() => { close(); shell.openPage('model-roles', { item: 'harness.embedding' }); }}>
          {t('settings.roles.title')}
        </Btn>} />
    </Row>
    {binding?.protocol === 'local' ? <LocalSemanticSettings /> : null}
    {error || catalogError ? <Note kind="err" inPanel actions={error ? <Btn kind="ghost" sm onClick={() => void retry()}>{t('assistant.reload')}</Btn> : undefined}>
      {error || catalogError}
    </Note> : null}
  </>;
  return <EmbeddingRequests key={targetKey} model={model} />;
}

export function AgentMemoryPage({ initialScope, scopes, embedded = false, onContentChange }: {
  initialScope?: AgentMemoryScope;
  scopes?: Array<{ scope: AgentMemoryScope; label: string }>;
  embedded?: boolean;
  onContentChange?(present: boolean): void;
} = {}) {
  const { t, locale } = useI18n();
  const settings = useAgentSettings();
  const threads = useThreadStore(state => state.threads);
  const threadNames = React.useMemo(() => new Map(threads.map(thread => [thread.thread_id, thread.title])), [threads]);
  const dateFormat = React.useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }), [locale]);
  const [scope, setScope] = React.useState<AgentMemoryScope>(initialScope ?? { kind: 'global' });
  const [draft, setDraft] = React.useState<{ id?: number; content: string; scope: AgentMemoryScope; revision: number } | null>(null);
  const [query, setQuery] = React.useState('');
  const initialKind = initialScope?.kind ?? 'global';
  const initialId = initialScope && 'id' in initialScope ? initialScope.id : '';
  React.useEffect(() => {
    setDraft(null);
    setScope(initialKind === 'global' ? { kind: 'global' } : { kind: initialKind, id: initialId });
  }, [settings.runtime, initialKind, initialId]);
  const filter = query.trim().toLocaleLowerCase();
  const items = settings.catalog?.memories.filter(note => agentScopeKey(note.scope) === agentScopeKey(scope)
    && (note.id === draft?.id || note.content.toLocaleLowerCase().includes(filter)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? [];
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
      className="max-w-full rounded-md border bg-background px-2 py-1.5 typography-meta">
      {scopes.map(option => <option key={agentScopeKey(option.scope)} value={agentScopeKey(option.scope)}>{option.label}</option>)}
    </select>
    : <AgentScopePicker scope={value} disabled={settings.busy} onChange={change} />;
  const add = <Btn sm icon="add" disabled={settings.busy || Boolean(draft) || !settings.catalog}
    onClick={() => {
      if (!settings.catalog) return;
      setQuery('');
      setDraft({ content: '', scope, revision: settings.catalog.revision });
    }}>
    {t(embedded ? 'assistant.add' : 'settings.memoryx.add')}
  </Btn>;
  const searchLabel = t('settings.memoryx.search');
  const toolbar = <>
    {picker(scope, next => {
      if (agentScopeKey(next) === agentScopeKey(scope)) return;
      requestSettingsNavigation(() => { setDraft(null); setScope(next); });
    })}
    <Field type="search" value={query} aria-label={searchLabel} placeholder={searchLabel}
      className="ml-auto min-w-0 max-w-full" onChange={event => setQuery(event.target.value)} />
    {embedded ? add : null}
  </>;
  const editor = draft ? <div className="sk-mem settings-memory-editor space-y-2">
    <Textarea autoFocus value={draft.content} rows={4} className="sk-area" aria-label={t('assistant.memory.content')}
      onChange={event => setDraft({ ...draft, content: event.target.value })} disabled={settings.busy} />
    <Disclosure label={t('assistant.move')}>
      <div className="sk-free">{picker(draft.scope, next => setDraft({ ...draft, scope: next }))}</div>
    </Disclosure>
    <SettingsActionBar placement="inline" saveLabel={t('assistant.save')} dirty saving={settings.busy} saveDisabled={!draft.content.trim()}
      onSave={save} onCancel={() => setDraft(null)} error={settings.error} />
  </div> : null;
  const content = <>
    {settings.error && !draft ? <Note kind="err" actions={<Btn kind="ghost" sm onClick={() => void settings.load()}>{t('assistant.reload')}</Btn>}>{settings.error}</Note> : null}
    <Section>
      {draft && draft.id === undefined ? editor : null}
      {!settings.catalog && !settings.error ? <Loading /> : null}
      {settings.catalog && !items.length && !draft ? <Empty icon={filter ? 'search' : 'book-2'}
        title={t(filter ? 'settings.memoryx.noMatches' : 'assistant.memory.empty')}
        description={!filter && !embedded ? t('settings.memoryx.emptyHint') : undefined} /> : null}
      {items.map(note => {
        if (draft?.id === note.id) return <React.Fragment key={note.id}>{editor}</React.Fragment>;
        const sourceThread = note.source?.threadId ? threadNames.get(note.source.threadId) : undefined;
        const source = sourceThread ? t('settings.memoryx.fromConversation', { name: sourceThread })
          : note.source?.label === 'user' ? t('settings.memoryx.sourceUser')
          : note.source?.label === 'agent' ? 'Agent' : note.source?.label;
        const updated = new Date(note.updatedAt);
        const hasDate = Number.isFinite(updated.getTime());
        return <article className="sk-mem" key={note.id}>
          <p className="break-words">{note.content}</p>
          <div className="sk-meta">
            {source ? <span className="sk-trunc max-w-full" title={source}>{source}</span> : null}
            {source && hasDate ? <span aria-hidden>·</span> : null}
            {hasDate ? <time dateTime={note.updatedAt} title={updated.toLocaleString(locale)}>{dateFormat.format(updated)}</time> : null}
            <span className="sk-grow" />
            <button type="button" className="sk-link disabled:opacity-50" disabled={settings.busy || Boolean(draft)}
              onClick={() => { if (settings.catalog) setDraft({ id: note.id, content: note.content, scope: note.scope, revision: settings.catalog.revision }); }}>
              {t('assistant.edit')}
            </button>
            <button type="button" className="sk-link disabled:opacity-50" disabled={settings.busy || Boolean(draft)} onClick={() => void remove(note)}>
              {t(embedded ? 'assistant.delete' : 'settings.memoryx.forget')}
            </button>
          </div>
        </article>;
      })}
    </Section>
  </>;
  return embedded ? <div className="sk">
    <div className="sk-lead">{toolbar}</div>
    {content}
  </div> : <Page title={t('assistant.memory.title')} description={t('assistant.memory.description')}
    scope={<SettingsScopeLabel kind="host" />} saved={false} actions={add} lead={toolbar}>
    {content}
    <MemoryRetrievalSettings />
  </Page>;
}
