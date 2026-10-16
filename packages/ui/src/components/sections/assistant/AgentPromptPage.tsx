import { useThreadStore } from '@/stores/useThreadStore';
import React from 'react';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { agentScopeKey, personalizeAgentSystemPrompt, renderAgentSystemPrompt, splitAgentSystemPrompt,
  type AgentMemoryScope, type AgentMemoryNote, type AgentSystemPromptSnapshot, type AgentSystemPromptPreview } from '@varin/protocol';
import { runtimeFetch, getRuntimeEndpointGeneration } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { AgentScopePicker } from './AgentScopePicker';
import { useAgentSettings } from './agentSettings';
import { subscribeVarinEvents } from '@/lib/varinEvents';

const presetText = {
  density: ['', 'Keep explanations concise while preserving facts needed for decisions.', 'Give a balanced amount of explanation and supporting evidence.', 'Explain the reasoning, tradeoffs, evidence and useful examples thoroughly.'],
  style: ['', 'Use direct, plain language and concrete wording.', 'Write naturally and conversationally.', 'Use a precise, professional tone.'],
  autonomy: ['', 'For open-ended work, discuss the approach before beginning implementation.', 'Complete clearly authorized tasks autonomously; ask when a consequential decision needs the user.', 'Proactively advance authorized work, make reasonable implementation decisions and continue through verification.'],
} as const;
const generated = (name: string) => ['runtime_identity', 'child_profile', 'cwd', 'skills', 'project_context', 'workspace_instructions', 'append_system'].includes(name) || name.startsWith('agent_memory_');
const editable = (sections: Record<string, string>) => Object.fromEntries(Object.entries(sections).filter(([name]) => !generated(name)));
interface PromptView extends AgentSystemPromptPreview { checkpoint?: AgentSystemPromptSnapshot }

export function AgentPromptPage() {
  const { t } = useI18n();
  const settings = useAgentSettings();
  const [scope, setScope] = React.useState<AgentMemoryScope>({ kind: 'global' });
  const [loaded, setLoaded] = React.useState<{ owner: string; view: PromptView | null } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [dirty, setDirty] = React.useState(false);
  const revision = React.useRef(0);
  const editOriginal = React.useRef<Record<string, string>>({});
  const [saved, setSaved] = React.useState(false);
  const { threads: runtime } = useRuntimeAPIs();
  const selected = useThreadStore(state => state.selectedIdentity);
  const summaries = useThreadStore(state => state.threads);
  const regularThreads = summaries.filter(thread => !thread.bot_id);
  const thread = scope.kind === 'thread' ? regularThreads.find(thread => thread.thread_id === scope.id) : undefined;
  const threadId = thread?.thread_id;
  const branchId = thread?.branches.find(branch => branch.branch_id === selected?.branchId)?.branch_id ?? thread?.branches[0]?.branch_id;
  const targetKey = JSON.stringify([settings.runtime, agentScopeKey(scope), branchId]);
  const view = loaded?.owner === targetKey ? loaded.view : null;
  const snapshot = view?.checkpoint;
  const projectId = scope.kind === 'project' ? scope.id : view?.projectId;
  const request = React.useRef(0);
  const owner = React.useRef(targetKey);
  React.useLayoutEffect(() => {
    owner.current = targetKey;
    setLoaded(null); setDirty(false); setDraft(''); setSaved(false); setError(null);
  }, [targetKey]);
  const projectTarget = scope.kind === 'project' ? scope.id : undefined;
  const reload = React.useCallback(async (signal?: AbortSignal): Promise<PromptView | null> => {
    if (!threadId) {
      if (scope.kind === 'thread') return null;
      const query = projectTarget ? `?projectId=${encodeURIComponent(projectTarget)}` : '';
      const response = await runtimeFetch(`/api/agent-personalization/prompt${query}`, { signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      return result as AgentSystemPromptPreview;
    }
    if (!runtime || !branchId) return null;
    const view = await runtime.snapshot({ runtime: 'agent', threadId: threadId, branchId });
    const checkpoint = view.context.checkpoint;
    const basis = checkpoint?.personalization;
    if (!checkpoint || !basis) return null;
    if (basis.threadId !== threadId || basis.mode !== 'agent') throw new Error('This Thread does not own ordinary assistant instructions');
    const original = Object.fromEntries(basis.originalSections.map(section => [section.name, section.content]));
    return { original, ...(basis.projectId ? { projectId: basis.projectId } : {}), checkpoint: { threadId, mode: 'agent', original, sections: splitAgentSystemPrompt(checkpoint.proposal.effective_system_prompt),
      content: checkpoint.proposal.effective_system_prompt,
      personalization: { mode: 'agent', revision: basis.revision, threadId, threadRole: basis.threadRole as 'main' | 'worker' | 'read-only',
        ...(basis.projectId ? { projectId: basis.projectId } : {}), profiles: [], memories: basis.memorySnapshot.memories as AgentMemoryNote[] },
      memorySnapshot: { revision: basis.memorySnapshot.revision, threadId, ...(basis.projectId ? { projectId: basis.projectId } : {}), memories: basis.memorySnapshot.memories as AgentMemoryNote[] } } };
  }, [runtime, threadId, branchId, scope.kind, projectTarget]);
  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    const current = ++request.current;
    setLoading(true);
    try {
      const value = await reload(signal);
      if (current === request.current && owner.current === targetKey && settings.runtime === getRuntimeEndpointGeneration() && !signal?.aborted) {
        setLoaded({ owner: targetKey, view: value }); setError(null);
      }
    } catch (failure) {
      if (current === request.current && owner.current === targetKey && !signal?.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (current === request.current && owner.current === targetKey && !signal?.aborted) setLoading(false);
    }
  }, [reload, targetKey, settings.runtime]);
  React.useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { controller.abort(); request.current += 1; };
  }, [refresh, settings.catalog?.revision, thread?.activity_cursor]);
  React.useEffect(() => subscribeVarinEvents(event => {
    if (event.type === 'stream-ready' || event.type === 'settings-changed' && event.owner === 'agent-settings') void refresh();
  }), [refresh]);
  const profile = settings.catalog?.prompts[agentScopeKey(scope)];
  const scopes = React.useMemo<AgentMemoryScope[]>(() => [{ kind: 'global' }, ...(projectId ? [{ kind: 'project', id: projectId } as const] : []),
    ...(threadId ? [{ kind: 'thread', id: threadId } as const] : [])], [projectId, threadId]);
  const original = React.useMemo(() => {
    const index = scopes.findIndex(value => agentScopeKey(value) === agentScopeKey(scope));
    return editable(personalizeAgentSystemPrompt(view?.original ?? {}, { mode: 'agent', revision: 0, memories: [],
      profiles: scopes.slice(0, index).map(owner => ({ scope: owner, profile: settings.catalog?.prompts[agentScopeKey(owner)] ?? { sections: {} } })) }));
  }, [view, scopes, scope, settings.catalog]);
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
  const activeKeys = new Set(scopes.map(agentScopeKey));
  const preview = view ? renderAgentSystemPrompt(personalizeAgentSystemPrompt(view.original, {
    mode: 'agent', revision: snapshot?.memorySnapshot?.revision ?? settings.catalog?.revision ?? 0,
    profiles: scopes.map(owner => ({ scope: owner, profile: agentScopeKey(owner) === agentScopeKey(scope)
      ? dirty ? { sections: overrides } : profile ?? { sections: {} } : settings.catalog?.prompts[agentScopeKey(owner)] ?? { sections: {} } })),
    memories: snapshot?.memorySnapshot?.memories ?? settings.catalog?.memories.filter(note => activeKeys.has(agentScopeKey(note.scope))) ?? [],
  })) : '';
  const save = async (reset = false) => {
    if (!settings.catalog || !view) return false;
    if (await settings.update('prompt', { scope, profile: reset ? null : { sections: overrides }, revision: reset ? settings.catalog.revision : revision.current })) {
      setDirty(false); setSaved(true);
      await refresh();
      return true;
    }
    return false;
  };
  return <SettingsPageLayout title={t('assistant.prompt.title')} description={t('assistant.prompt.description')} showSaveStatus={false}>
    <div className="grid gap-6 md:grid-cols-[170px_minmax(0,1fr)]">
      <AgentScopePicker scope={scope} disabled={settings.busy} onChange={next => {
        requestSettingsNavigation(() => { setDirty(false); setSaved(false); setScope(next); });
      }} />
      <div className="min-w-0 space-y-4">
        {error || settings.error ? <div role="alert" className="text-destructive typography-meta">{error || settings.error}</div> : null}
        {!view && !error && !settings.error ? <p role="status">{t(loading ? 'assistant.prompt.loading' : 'assistant.prompt.noContext')}</p> : null}
        <Textarea value={draft} onChange={event => { setDraft(event.target.value); setDirty(true); setSaved(false); }}
          aria-label={t('assistant.prompt.editor')} rows={16} disabled={settings.busy || !view || !settings.catalog}
          className="min-h-80 resize-y font-mono text-sm leading-6" />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span role="status" className="typography-meta text-muted-foreground">{dirty ? t('assistant.unsaved') : saved ? t('assistant.saved') : t('assistant.prompt.nextRequest')}</span>
          <Button variant="ghost" disabled={!profile || settings.busy} onClick={() => void save(true)}>{t('assistant.prompt.reset')}</Button>
        </div>
        <div className="grid gap-3 border-t pt-4 sm:grid-cols-3">{(['density', 'style', 'autonomy'] as const).map(key => <label key={key} className="space-y-1.5 typography-meta">
          <span>{t(`assistant.preset.${key}`)}</span>
          <select className="w-full rounded-md border bg-background p-2" disabled={settings.busy || !view || !settings.catalog}
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
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>{t('assistant.reload')}</Button>
        </div><p className="typography-micro text-muted-foreground">{t(scope.kind === 'thread' ? 'assistant.prompt.sources' : 'assistant.prompt.currentSources')}</p>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-3 text-xs leading-6">{preview}</pre>
        </section>
        {snapshot?.lastRequest ? <details className="border-t pt-3"><summary className="cursor-pointer typography-meta">{t('assistant.prompt.lastRequest')} · {new Date(snapshot.lastRequest.timestamp).toLocaleTimeString()}</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{snapshot.lastRequest.content}</pre>
        </details> : null}
      </div>
    </div>
    <SettingsActionBar saveLabel={t('assistant.save')} dirty={dirty} saving={settings.busy} saveDisabled={!view || !settings.catalog} onSave={() => save()} onCancel={() => { setDraft(stored); setDirty(false); setError(null); }} error={error || settings.error} />
  </SettingsPageLayout>;
}
