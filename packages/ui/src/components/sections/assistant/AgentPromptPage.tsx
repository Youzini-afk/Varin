import { useProjectsStore } from '@/stores/useProjectsStore';
import { useThreadStore } from '@/stores/useThreadStore';
import React from 'react';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { copyTextToClipboard } from '@/lib/clipboard';
import { agentScopeKey, personalizeAgentSystemPrompt, renderAgentSystemPrompt, splitAgentSystemPrompt,
  type AgentMemoryScope, type AgentMemoryNote, type AgentSystemPromptSnapshot, type AgentSystemPromptPreview, type AgentToolPrompt } from '@varin/protocol';
import { runtimeFetch, getRuntimeEndpointGeneration } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { SettingsScopeLabel } from '../shared/SettingsScope';
import { Btn, Disclosure, Ic, Loading, Note, Page, Row, SaveDock, Section, Seg, Select, Tabs } from '../shared/kit';
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
const supplemental = (kind: AgentMemoryScope['kind']) => `user_instructions_${kind}`;
const managed = new Set([...Object.keys(presetText).map(key => `preference_${key}`),
  ...(['global', 'project', 'thread'] as const).map(supplemental)]);
const editable = (name: string) => !generated(name) && !managed.has(name);
type PromptDraft = { sections: Record<string, string | null>; revision: number; advancedText?: string };
interface PromptView extends AgentSystemPromptPreview { checkpoint?: AgentSystemPromptSnapshot }

export function AgentPromptPage() {
  const { t } = useI18n();
  const [pageTab, setPageTab] = React.useState<'custom' | 'preview'>('custom');
  const settings = useAgentSettings();
  const [scope, setScope] = React.useState<AgentMemoryScope>({ kind: 'global' });
  const [loaded, setLoaded] = React.useState<{ owner: string; view: PromptView | null } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<PromptDraft | null>(null);
  const [copyStatus, setCopyStatus] = React.useState<'copied' | 'failed'>();
  const [previewPart, setPreviewPart] = React.useState<'system' | 'tools'>('system');
  const [toolCatalog, setToolCatalog] = React.useState<{ owner: string; tools: AgentToolPrompt[] } | null>(null);
  const [toolsLoading, setToolsLoading] = React.useState(false);
  const [toolsError, setToolsError] = React.useState<string | null>(null);
  const { threads: runtime } = useRuntimeAPIs();
  const selected = useThreadStore(state => state.selectedIdentity);
  const summaries = useThreadStore(state => state.threads);
  const regularThreads = summaries.filter(thread => !thread.bot_id);
  const thread = scope.kind === 'thread' ? regularThreads.find(thread => thread.thread_id === scope.id) : undefined;
  const threadId = thread?.thread_id;
  const branchId = thread?.branches.find(branch => branch.branch_id === selected?.branchId)?.branch_id ?? thread?.branches[0]?.branch_id;
  const projectSource = useProjectsStore(state => scope.kind === 'project' ? state.projects.find(project => project.id === scope.id)?.source : undefined);
  const sourceKey = JSON.stringify(projectSource);
  const targetKey = JSON.stringify([settings.runtime, agentScopeKey(scope), branchId, sourceKey]);
  const view = loaded?.owner === targetKey ? loaded.view : null;
  const snapshot = view?.checkpoint;
  const tools = threadId ? view?.tools : toolCatalog?.owner === targetKey ? toolCatalog.tools : undefined;
  const toolPreview = React.useMemo(() => tools?.map(tool =>
    `${tool.name}\n\n${tool.description}\n\n${JSON.stringify(tool.schema, null, 2)}`).join('\n\n────────────────────────\n\n') ?? '', [tools]);
  const projectId = scope.kind === 'project' ? scope.id : view?.projectId;
  const request = React.useRef(0);
  const owner = React.useRef(targetKey);
  React.useLayoutEffect(() => {
    owner.current = targetKey;
    setLoaded(null); setDraft(null); setCopyStatus(undefined); setError(null);
    setToolCatalog(null); setToolsLoading(false); setToolsError(null);
  }, [targetKey]);
  const projectTarget = scope.kind === 'project' ? scope.id : undefined;
  React.useEffect(() => {
    if (!view || scope.kind === 'thread' || pageTab !== 'preview' || previewPart !== 'tools') return;
    const controller = new AbortController();
    setToolsLoading(true); setToolsError(null);
    const query = projectTarget ? `?projectId=${encodeURIComponent(projectTarget)}${projectSource ? `&expectedSource=${encodeURIComponent(JSON.stringify(projectSource))}` : ''}` : '';
    void runtimeFetch(`/api/agent-personalization/tools${query}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (!controller.signal.aborted && owner.current === targetKey && settings.runtime === getRuntimeEndpointGeneration()) setToolCatalog({ owner: targetKey, tools: result });
    }).catch(failure => {
      if (!controller.signal.aborted && owner.current === targetKey) setToolsError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => { if (!controller.signal.aborted && owner.current === targetKey) setToolsLoading(false); });
    return () => controller.abort();
  }, [scope.kind, pageTab, previewPart, projectTarget, projectSource, targetKey, settings.runtime, view]);
  const reload = React.useCallback(async (signal?: AbortSignal): Promise<PromptView | null> => {
    if (!threadId) {
      if (scope.kind === 'thread') return null;
      const query = projectTarget ? `?projectId=${encodeURIComponent(projectTarget)}${projectSource ? `&expectedSource=${encodeURIComponent(JSON.stringify(projectSource))}` : ''}` : '';
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
    return { original, tools: view.launch?.selection.tools.map(({ name, description, schema }) => ({ name, description, schema })) ?? [],
      ...(basis.projectId ? { projectId: basis.projectId } : {}), checkpoint: { threadId, mode: 'agent', original, sections: splitAgentSystemPrompt(checkpoint.proposal.effective_system_prompt),
      content: checkpoint.proposal.effective_system_prompt,
      personalization: { mode: 'agent', revision: basis.revision, threadId, threadRole: basis.threadRole as 'main' | 'worker' | 'read-only',
        ...(basis.projectId ? { projectId: basis.projectId } : {}), profiles: [], memories: basis.memorySnapshot.memories as AgentMemoryNote[] },
      memorySnapshot: { revision: basis.memorySnapshot.revision, threadId, ...(basis.projectId ? { projectId: basis.projectId } : {}), memories: basis.memorySnapshot.memories as AgentMemoryNote[] } } };
  }, [runtime, threadId, branchId, scope.kind, projectTarget, projectSource]);
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
  const profilesFor = (scope: AgentMemoryScope) => settings.catalog?.prompts[agentScopeKey(scope)] ?? { sections: {} };
  const scopes: AgentMemoryScope[] = [{ kind: 'global' }, ...(projectId ? [{ kind: 'project', id: projectId } as const] : []),
    ...(threadId ? [{ kind: 'thread', id: threadId } as const] : [])];
  const currentScopeKey = agentScopeKey(scope);
  const inherited = personalizeAgentSystemPrompt(view?.original ?? {}, { mode: 'agent', revision: 0, memories: [],
    profiles: scopes.filter(owner => agentScopeKey(owner) !== currentScopeKey).map(scope => ({ scope, profile: profilesFor(scope) })) });
  const stored = profile?.sections ?? {};
  const overrides = draft?.sections ?? stored;
  const dirty = Object.keys(stored).length !== Object.keys(overrides).length
    || Object.entries(overrides).some(([name, text]) => stored[name] !== text);
  const canEdit = Boolean(view && settings.catalog && !settings.busy);
  const noteSection = supplemental(scope.kind);
  const effective = { ...inherited, ...overrides };
  const activeKeys = new Set(scopes.map(agentScopeKey));
  const activeProfiles = scopes.map(scope => ({ scope, profile: agentScopeKey(scope) === currentScopeKey ? { sections: overrides } : profilesFor(scope) }));
  const previewSections = view ? personalizeAgentSystemPrompt(view.original, {
    mode: 'agent', revision: snapshot?.memorySnapshot?.revision ?? settings.catalog?.revision ?? 0, profiles: activeProfiles,
    memories: snapshot?.memorySnapshot?.memories ?? settings.catalog?.memories.filter(note => activeKeys.has(agentScopeKey(note.scope))) ?? [],
  }) : {};
  const preview = renderAgentSystemPrompt(previewSections);
  const advanced = Object.fromEntries(Object.entries(effective).filter((entry): entry is [string, string] => editable(entry[0]) && entry[1] !== null));
  const advancedText = draft?.advancedText ?? renderAgentSystemPrompt(advanced);
  const changeDraft = (change: (sections: PromptDraft['sections']) => void, advancedText?: string | null) => {
    if (!canEdit || !settings.catalog) return;
    const revision = settings.catalog.revision;
    setDraft(previous => {
      const sections = { ...(previous?.sections ?? stored) };
      change(sections);
      return { sections, revision: previous?.revision ?? revision,
        advancedText: advancedText === undefined ? previous?.advancedText : advancedText ?? undefined };
    });
  };
  const setSection = (name: string, text: string) => changeDraft(sections => {
    if (text === (inherited[name] ?? '')) delete sections[name];
    else sections[name] = text || null;
  });
  const changeAdvanced = (text: string) => {
    const next = splitAgentSystemPrompt(text);
    changeDraft(sections => {
      for (const name of new Set([...Object.keys(advanced), ...Object.keys(next)])) {
        if (!editable(name)) continue;
        const value = next[name] || undefined;
        if (value === (advanced[name] || undefined)) continue;
        if (value === (inherited[name] || undefined)) delete sections[name];
        else sections[name] = value ?? null;
      }
    }, text);
  };
  const save = async () => {
    if (!draft || !canEdit || !dirty) return false;
    const saved = await settings.update('prompt', { scope, profile: Object.keys(overrides).length ? { sections: overrides } : null, revision: draft.revision });
    if (saved && owner.current === targetKey) setDraft(null);
    return saved;
  };
  const resetCopy = () => setCopyStatus(undefined);
  const displayedPreview = previewPart === 'system' ? preview : toolPreview;
  const handleCopy = async () => {
    try { setCopyStatus((await copyTextToClipboard(displayedPreview)).ok ? 'copied' : 'failed'); }
    catch { setCopyStatus('failed'); }
  };
  const hasSection = (name: string) => Boolean(previewSections[name]);
  const densityLabel = t('assistant.preset.density');
  const toneLabel = t('assistant.preset.style');
  const autonomyLabel = t('assistant.preset.autonomy');
  const presetOptions = (key: keyof typeof presetText) => {
    const name = `preference_${key}`;
    const selected = String(presetText[key].findIndex(value => value === (effective[name] ?? '')));
    const options = presetText[key].map((_, index) => ({ value: String(index),
      label: t(index === 0 ? 'assistant.preset.default' : `assistant.preset.${key}.${index}` as 'assistant.preset.density.1') }));
    if (selected === '-1') options.unshift({ value: '-1', label: t('assistant.preset.custom') });
    return { value: selected, onChange: (index: string) => {
      const text = presetText[key][Number(index)];
      if (text !== undefined) setSection(name, text);
    }, options: options.map(option => ({ ...option, disabled: option.value === '-1' })), disabled: !canEdit };
  };
  const parts = [
    t('settings.promptx.base'),
    ...(activeProfiles.some(({ profile }) => Object.keys(profile.sections).length) ? [t('settings.promptx.mine')] : []),
    ...(hasSection('project_context') || hasSection('workspace_instructions') ? [t('settings.promptx.projectFiles')] : []),
    ...(hasSection('skills') ? [t('settings.page.skills.title')] : []),
    ...(hasSection('agent_memory_snapshot') ? [t('settings.promptx.memorySnapshot')] : []),
  ];
  const previewHint = previewPart === 'tools' ? scope.kind === 'thread' ? 'assistant.prompt.toolSources' : 'assistant.prompt.toolCatalogSources'
    : scope.kind === 'thread' ? 'assistant.prompt.sources' : 'assistant.prompt.currentSources';
  const failure = error || settings.error;

  return <Page title={t('assistant.prompt.title')} description={t('assistant.prompt.description')} scope={<SettingsScopeLabel kind="host" />} saved={false}
    dock={<SaveDock saveLabel={t('assistant.save')} dirty={dirty} saving={settings.busy} saveDisabled={!view || !settings.catalog}
      onSave={save} onCancel={() => setDraft(null)} message={t('settings.promptx.unsaved')} />}>
    <Tabs value={pageTab} onChange={value => { setPageTab(value); resetCopy(); }} label={t('assistant.prompt.title')}
      tabs={[{ value: 'custom', label: t('settings.promptx.mine') }, { value: 'preview', label: t('assistant.prompt.effective') }]} />
    <div className="-mt-2 mb-8">
      <AgentScopePicker prompt scope={scope} disabled={settings.busy} onChange={setNextScope => {
        if (agentScopeKey(setNextScope) !== currentScopeKey) requestSettingsNavigation(() => setScope(setNextScope));
      }} />
    </div>
    {failure ? <Note kind="err" actions={<Btn kind="ghost" sm disabled={loading} onClick={() => { void settings.load(); void refresh(); }}>{t('assistant.reload')}</Btn>}>{failure}</Note> : null}
    {!view && !failure ? loading ? <Loading label={t('assistant.prompt.loading')} /> : <Note>{t('assistant.prompt.noContext')}</Note> : null}
    <div hidden={pageTab !== 'custom'}>
      <Section title={t('settings.promptx.style')} description={t('settings.promptx.styleHint')}>
        <Row label={densityLabel}><Seg label={densityLabel} {...presetOptions('density')} /></Row>
        <Row label={toneLabel}><Seg label={toneLabel} {...presetOptions('style')} /></Row>
        <Row label={autonomyLabel}><Select label={autonomyLabel} {...presetOptions('autonomy')} /></Row>
      </Section>
      <Section title={t('settings.promptx.additional')} description={t('settings.promptx.additionalHint')} raw>
        <div className="sk-doc">
          <div className="sk-bar"><span className="sk-grow">Markdown</span>
            <Btn kind="ghost" sm disabled={!canEdit || !overrides[noteSection]} onClick={() => setSection(noteSection, '')}>{t('assistant.prompt.reset')}</Btn>
          </div>
          <Textarea value={overrides[noteSection] ?? ''} onChange={event => setSection(noteSection, event.target.value)}
            aria-label={t('settings.promptx.additional')} placeholder={t('settings.promptx.placeholder')} rows={10} disabled={!canEdit} className="sk-area" />
        </div>
      </Section>
      <Section>
        <Disclosure label={t('settings.promptx.advanced')}>
          <div className="sk-hstack wrap mb-3">
            <p className="sk-grow sk-muted text-xs">{t('settings.promptx.advancedHint')}</p>
            <Btn kind="ghost" sm disabled={!canEdit || !Object.keys(overrides).some(editable)}
              onClick={() => changeDraft(sections => {
                for (const name of Object.keys(sections)) if (editable(name)) delete sections[name];
              }, null)}>{t('assistant.prompt.reset')}</Btn>
          </div>
          <Textarea value={advancedText} onChange={event => changeAdvanced(event.target.value)}
            aria-label={t('assistant.prompt.editor')} rows={12} disabled={!canEdit} className="sk-area" />
        </Disclosure>
      </Section>
    </div>
    <div hidden={pageTab !== 'preview'}>
      {view ? <>
        <Section title={t('settings.promptx.parts')} description={t(previewHint)}
          actions={<Btn kind="ghost" sm icon="refresh" tip={t('assistant.reload')} disabled={loading} onClick={() => void refresh()} />}>
          {parts.map(part => <Row key={part} label={part} />)}
        </Section>
        <Section title={t('settings.promptx.preview')} raw>
          <div className="sk-doc">
            <div className="sk-bar flex-wrap">
              <span className="sk-hstack"><Ic name="eye" size="sm" />{t('settings.promptx.readOnly')}</span>
              <Seg value={previewPart} onChange={value => { setPreviewPart(value); resetCopy(); }} label={t('settings.promptx.preview')}
                options={[{ value: 'system', label: t('assistant.prompt.systemText') }, { value: 'tools', label: t('assistant.prompt.tools') }]} />
              <span className="sk-grow" />
              <span role="status">{copyStatus ? t(`settings.promptx.${copyStatus}`) : null}</span>
              <Btn kind="ghost" sm icon="file-copy" disabled={!displayedPreview} onClick={() => void handleCopy()}>{t('settings.promptx.copy')}</Btn>
            </div>
            {previewPart === 'tools' && toolsError && !threadId ? <Note kind="err">{toolsError}</Note>
              : previewPart === 'tools' && toolsLoading && !threadId ? <Loading />
              : <pre className="m-0 max-h-[32rem] min-h-40 overflow-auto whitespace-pre-wrap break-words px-4 py-3 text-xs leading-6">
                {previewPart === 'system' ? preview : toolPreview || t('assistant.prompt.noTools')}
              </pre>}
          </div>
        </Section>
        {snapshot?.lastRequest ? <Section>
          <Disclosure label={t('assistant.prompt.lastRequest')} summary={new Date(snapshot.lastRequest.timestamp).toLocaleTimeString()}>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{snapshot.lastRequest.content}</pre>
          </Disclosure>
        </Section> : null}
      </> : null}
    </div>
  </Page>;
}
