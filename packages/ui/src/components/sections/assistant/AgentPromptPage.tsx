import React from 'react';
import { agentScopeKey, personalizeAgentSystemPrompt, renderAgentSystemPrompt, splitAgentSystemPrompt,
  type AgentMemoryScope, type AgentSystemPromptSnapshot, type RuntimeContextTarget } from '@varin/protocol';
import { getRuntimeKey, projectContainsPath } from '@varin/application-client';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { getPiRuntimeConnection } from '@/lib/pi-runtime/client';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useBotSessionIndex, regularPiSessions } from '@/stores/useBotSessionIndex';
import { AgentScopePicker } from './AgentScopePicker';
import { useAgentSettings } from './agentSettings';

const presetText = {
  density: ['', 'Keep explanations concise while preserving facts needed for decisions.', 'Give a balanced amount of explanation and supporting evidence.', 'Explain the reasoning, tradeoffs, evidence and useful examples thoroughly.'],
  style: ['', 'Use direct, plain language and concrete wording.', 'Write naturally and conversationally.', 'Use a precise, professional tone.'],
  autonomy: ['', 'For open-ended work, discuss the approach before beginning implementation.', 'Complete clearly authorized tasks autonomously; ask when a consequential decision needs the user.', 'Proactively advance authorized work, make reasonable implementation decisions and continue through verification.'],
} as const;
const generated = (name: string) => name === 'cwd' || name === 'skills' || name === 'project_context' || name.startsWith('agent_memory_');
const editable = (sections: Record<string, string>) => Object.fromEntries(Object.entries(sections).filter(([name]) => !generated(name)));

export function AgentPromptPage() {
  const { t } = useI18n();
  const settings = useAgentSettings();
  const [scope, setScope] = React.useState<AgentMemoryScope>({ kind: 'global' });
  const [snapshot, setSnapshot] = React.useState<AgentSystemPromptSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [dirty, setDirty] = React.useState(false);
  const revision = React.useRef(0);
  const editOriginal = React.useRef<Record<string, string>>({});
  const [saved, setSaved] = React.useState(false);
  const currentSessionId = usePiSessionStore(state => state.currentSessionId);
  const summaries = usePiSessionStore(state => state.summaries);
  const botIndex = useBotSessionIndex();
  const regularSessions = regularPiSessions(summaries, botIndex, getRuntimeKey());
  const projects = useProjectsStore(state => state.projects);
  const directory = useDirectoryStore(state => state.currentDirectory);
  const sessionId = scope.kind === 'session' ? scope.id : regularSessions.find(session => session.id === currentSessionId)?.id;
  const open = usePiSessionStore(state => !!sessionId && !!state.records[sessionId]?.open);
  const cwd = scope.kind === 'project' ? projects.find(project => project.id === scope.id)?.path ?? directory
    : summaries.find(session => session.id === sessionId)?.cwd ?? directory;
  const projectId = scope.kind === 'project' ? scope.id : projects.find(project => projectContainsPath(project, cwd))?.id;
  const target = React.useMemo<RuntimeContextTarget>(() => scope.kind !== 'project' && sessionId && open ? { sessionId } : { cwd }, [scope.kind, sessionId, open, cwd]);
  const targetKey = JSON.stringify([settings.runtime, target]);
  const reload = React.useCallback(async () => {
    const { client } = await getPiRuntimeConnection();
    return client.request('session.systemPrompt', target);
  }, [target]);
  React.useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    setSnapshot(null); setDirty(false); setError(null);
    const refresh = () => void reload().then(value => { if (active) { setSnapshot(value); setError(null); } })
      .catch(failure => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); });
    refresh();
    void getPiRuntimeConnection().then(({ client }) => {
      if (!active) return;
      unsubscribe = client.subscribe(event => {
        if (event.event === 'agent.event' && event.data.sessionId === sessionId
          && (event.data.event.type === 'message_start' || event.data.event.type === 'agent_end')) refresh();
      });
    }).catch(() => undefined);
    return () => { active = false; unsubscribe?.(); };
  }, [reload, targetKey, sessionId]);
  const profile = settings.catalog?.prompts[agentScopeKey(scope)];
  const original = React.useMemo(() => editable(snapshot?.original ?? {}), [snapshot]);
  const stored = React.useMemo(() => {
    const value = { ...original };
    for (const [key, text] of Object.entries(profile?.sections ?? {})) { if (text === null) delete value[key]; else value[key] = text; }
    return renderAgentSystemPrompt(value);
  }, [original, profile]);
  React.useEffect(() => { if (!dirty) { setDraft(stored); editOriginal.current = original; revision.current = settings.catalog?.revision ?? 0; } }, [stored, dirty, original, settings.catalog?.revision]);
  const draftSections = splitAgentSystemPrompt(draft);
  const overrides: Record<string, string | null> = {};
  for (const name of new Set([...Object.keys(editOriginal.current), ...Object.keys(draftSections)])) {
    if (draftSections[name] !== editOriginal.current[name]) overrides[name] = draftSections[name] ?? null;
  }
  const scopes: AgentMemoryScope[] = [{ kind: 'global' }, ...(projectId ? [{ kind: 'project' as const, id: projectId }] : []),
    ...(sessionId ? [{ kind: 'session' as const, id: sessionId }] : [])];
  const activeKeys = new Set(scopes.map(agentScopeKey));
  const preview = snapshot ? renderAgentSystemPrompt(personalizeAgentSystemPrompt(snapshot.original, {
    mode: snapshot.mode, revision: snapshot.memorySnapshot?.revision ?? settings.catalog?.revision ?? 0,
    threadRole: snapshot.personalization.threadRole, sessionId: sessionId ?? snapshot.sessionId,
    profiles: scopes.map(owner => ({ scope: owner, profile: agentScopeKey(owner) === agentScopeKey(scope)
      ? { sections: overrides } : settings.catalog?.prompts[agentScopeKey(owner)] ?? { sections: {} } })),
    memories: snapshot.memorySnapshot?.memories ?? settings.catalog?.memories.filter(note => activeKeys.has(agentScopeKey(note.scope))) ?? [],
  })) : '';
  const save = async (reset = false) => {
    if (!settings.catalog) return;
    if (await settings.update('prompt', { scope, profile: reset ? null : { sections: overrides }, revision: reset ? settings.catalog.revision : revision.current })) {
      setDirty(false); setSaved(true);
      try { setSnapshot(await reload()); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    }
  };
  return <SettingsPageLayout title={t('assistant.prompt.title')} description={t('assistant.prompt.description')} showSaveStatus={false}>
    <div className="grid gap-6 md:grid-cols-[170px_minmax(0,1fr)]">
      <AgentScopePicker scope={scope} disabled={settings.busy} onChange={next => {
        if (dirty && !window.confirm(t('assistant.discard'))) return;
        setDirty(false); setSaved(false); setScope(next);
      }} />
      <div className="min-w-0 space-y-4">
        {error || settings.error ? <div role="alert" className="text-destructive typography-meta">{error || settings.error}</div> : null}
        {!snapshot ? <p role="status">{error ? t('assistant.prompt.unavailable') : t('common.loading')}</p> : null}
        <Textarea value={draft} onChange={event => { setDraft(event.target.value); setDirty(true); setSaved(false); }}
          aria-label={t('assistant.prompt.editor')} rows={16} disabled={!snapshot || settings.busy || snapshot.mode === 'bot'}
          className="min-h-80 resize-y font-mono text-sm leading-6" />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span role="status" className="typography-meta text-muted-foreground">{dirty ? t('assistant.unsaved') : saved ? t('assistant.saved') : t('assistant.prompt.nextRequest')}</span>
          <div className="flex gap-2"><Button variant="ghost" disabled={!profile || settings.busy} onClick={() => void save(true)}>{t('assistant.prompt.reset')}</Button>
            <Button disabled={!dirty || !snapshot || settings.busy || snapshot.mode === 'bot'} onClick={() => void save()}>{t('assistant.save')}</Button></div>
        </div>
        <div className="grid gap-3 border-t pt-4 sm:grid-cols-3">{(['density', 'style', 'autonomy'] as const).map(key => <label key={key} className="space-y-1.5 typography-meta">
          <span>{t(`assistant.preset.${key}`)}</span>
          <select className="w-full rounded-md border bg-background p-2" disabled={!snapshot || settings.busy || snapshot.mode === 'bot'}
            value={presetText[key].findIndex(value => value === (draftSections[`preference_${key}`] ?? ''))}
            onChange={event => {
              const next = { ...draftSections }; const value = presetText[key][Number(event.target.value)];
              if (value) next[`preference_${key}`] = value; else delete next[`preference_${key}`];
              setDraft(renderAgentSystemPrompt(next)); setDirty(true); setSaved(false);
            }}>
            <option value={-1} disabled>{t('assistant.preset.custom')}</option>
            {presetText[key].map((_, index) => <option key={index} value={index}>{t(index === 0 ? 'assistant.preset.default' : `assistant.preset.${key}.${index}` as 'assistant.preset.density.1')}</option>)}
          </select>
        </label>)}</div>
        <section className="space-y-2 border-t pt-4"><div className="flex items-center justify-between gap-2">
          <h3 className="typography-ui-label">{t('assistant.prompt.effective')}</h3>
          <Button variant="ghost" size="sm" onClick={() => void reload().then(setSnapshot).catch(failure => setError(String(failure)))}>{t('assistant.reload')}</Button>
        </div><p className="typography-micro text-muted-foreground">{t('assistant.prompt.sources')}</p>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-3 text-xs leading-6">{preview}</pre>
        </section>
        {snapshot?.lastRequest ? <details className="border-t pt-3"><summary className="cursor-pointer typography-meta">{t('assistant.prompt.lastRequest')} · {new Date(snapshot.lastRequest.timestamp).toLocaleTimeString()}</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{snapshot.lastRequest.content}</pre>
        </details> : null}
      </div>
    </div>
  </SettingsPageLayout>;
}
