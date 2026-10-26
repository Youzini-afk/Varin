import React from 'react';
import { THINKING_LEVELS, type ThinkingLevel } from '@varin/protocol';
import { ThreadRequestError, getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadSnapshot, type ThreadsAPI } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { ChatThinkingBlock } from '@/components/conversation/ChatThinkingBlock';
import { copyTextToClipboard } from '@/lib/clipboard';
import { contextJobPhase, contextPhaseLabels, contextWaitsFor, latestContextJob } from '@/lib/contextPresentation';
import { contextUsageKey, threadContextModel, useThreadContextUsageStore } from '@/stores/useThreadContextUsageStore';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { ThreadHistoryWindow } from '@/lib/agent-runtime/thread-history';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { ThreadTokenUsage } from '@/components/thread/ThreadTokenUsage';
import { ContextBudgetView } from './ContextBudgetView';
import { ContextDisclosure } from './ContextDisclosure';
import { readableContextSummary, useContextJobHistory } from './useContextJobHistory';
import { contextMessageKinds } from './contextMessages';
import './context-manager.css';

export function ContextInspector({ api, identity, snapshot, active, jobRunId, error, readOnly, refresh }: {
  api: ThreadsAPI; identity: ThreadIdentity; snapshot: ThreadSnapshot; active: boolean; jobRunId?: string; error?: string; readOnly?: boolean; refresh(): Promise<void>;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = React.useState<string | null>(jobRunId ?? null);
  React.useEffect(() => setSelected(jobRunId ?? null), [jobRunId]);
  const latest = latestContextJob(snapshot), row = selected ? snapshot.context.jobs.find(row => row.run.id === selected) : latest;
  const phase = row ? contextJobPhase(row, snapshot) : undefined;
  const historical = !!row && (row !== latest || phase === 'applied' && row.job.request.key !== snapshot.context.checkpoint?.id);
  const [processOpen, setProcessOpen] = React.useState(false), [summaryOpen, setSummaryOpen] = React.useState(false);
  const summaryElement = React.useRef<HTMLDivElement>(null);
  const [summaryOverflow, setSummaryOverflow] = React.useState(false);
  const [pending, setPending] = React.useState(false), [actionError, setActionError] = React.useState<string>();
  const [copied, setCopied] = React.useState<string>(), [usageOpen, setUsageOpen] = React.useState(false);
  const [messageFilter, setMessageFilter] = React.useState('all'), [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [messagesOpen, setMessagesOpen] = React.useState(false);
  const host = getRuntimeEndpointGeneration(), lifetime = React.useRef(0);
  const pendingAction = React.useRef<object | null>(null);
  const preparationKeys = React.useRef(new Map<string, string>());
  React.useEffect(() => {
    const current = ++lifetime.current;
    pendingAction.current = null; setPending(false); setActionError(undefined); preparationKeys.current.clear();
    return () => { lifetime.current = current + 1; pendingAction.current = null; };
  }, [identity.runtime, identity.threadId, identity.branchId, host, api]);
  const draftKey = threadComposerKey(threadHostKey(), identity);
  const inputPending = useThreadDraftStore(state => Boolean(state.drafts[draftKey]?.pendingInput || state.drafts[draftKey]?.firstSend?.status === 'sending'));
  const view = useThreadContextUsageStore(state => state.views[contextUsageKey(identity)]);
  const inspection = view?.inspection, request = inspection?.latestRequest, model = threadContextModel(snapshot);
  const channel = useModelCatalogStore(state => state.channels.find(channel => channel.id === model?.providerId));
  const modelName = channel?.models.find(candidate => candidate.id === (model?.catalogModelId ?? model?.model))?.name ?? model?.model ?? '—';
  const jobHistory = useContextJobHistory(api, identity, row, active && Boolean(processOpen || historical || phase === 'ready'));
  const candidate = jobHistory.parts.filter(part => part.type === 'text').at(-1);
  const summary = historical ? jobHistory.page?.checkpoint?.proposal.summary
    : phase === 'ready' ? candidate?.type === 'text' ? readableContextSummary(candidate.text) : undefined : snapshot.context.checkpoint?.proposal.summary;
  const rawPrompt = historical ? jobHistory.page?.checkpoint?.proposal.effective_system_prompt : snapshot.context.checkpoint?.proposal.effective_system_prompt;
  const resourceCheckpoint = historical ? jobHistory.page?.checkpoint : snapshot.context.checkpoint;
  const resources = resourceCheckpoint?.resources?.snapshot;
  React.useLayoutEffect(() => {
    if (summaryOpen || !summaryElement.current) return;
    const element = summaryElement.current;
    const measure = () => setSummaryOverflow(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [summary, summaryOpen]);
  const blocking = !!row && contextWaitsFor(row, snapshot);
  const sourceClosed = snapshot.activeRun === null && snapshot.thread.branches.find(branch => branch.branch_id === identity.branchId)?.latest_run?.state === 'failed';
  const description = phase === 'waiting' ? 'contextManager.blockedHint' : phase === 'ready' ? 'contextManager.readyHint'
    : phase === 'applied' ? sourceClosed ? 'contextManager.appliedStoppedHint' : 'contextManager.appliedHint'
      : phase === 'failed' ? blocking ? 'contextManager.blockedFailure' : 'contextManager.backgroundFailure'
        : phase === 'cancelled' ? 'contextManager.cancelledHint' : phase === 'superseded' ? 'contextManager.supersededHint' : 'contextManager.backgroundHint';
  const scroll = React.useRef<HTMLDivElement>(null), sentinel = React.useRef<HTMLDivElement>(null);
  const historyWindow = React.useMemo(() => new ThreadHistoryWindow(api, identity, { usage: false }), [api, identity]);
  const subscribe = React.useCallback((listener: () => void) => active ? historyWindow.subscribe(listener) : () => {}, [active, historyWindow]);
  const history = React.useSyncExternalStore(subscribe, historyWindow.getSnapshot, historyWindow.getSnapshot);
  React.useEffect(() => { if (active) historyWindow.accept(snapshot); }, [active, historyWindow, snapshot]);
  React.useEffect(() => {
    if (!active || !messagesOpen || !history.previous || history.loading || history.error || !sentinel.current || !scroll.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void historyWindow.loadEarlier(); }, { root: scroll.current, rootMargin: '300px' });
    observer.observe(sentinel.current); return () => observer.disconnect();
  }, [active, messagesOpen, history.previous, history.loading, history.error, historyWindow]);
  React.useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(undefined), 2000); return () => clearTimeout(timer); } }, [copied]);
  const copy = async (id: string, content: string) => { const result = await copyTextToClipboard(content); if (result.ok) setCopied(id); else setActionError(result.error); };
  const act = async (action: () => Promise<unknown>) => {
    if (readOnly || pendingAction.current || host !== getRuntimeEndpointGeneration()) return;
    const token = {}; pendingAction.current = token;
    const generation = lifetime.current;
    const current = () => generation === lifetime.current && host === getRuntimeEndpointGeneration() && pendingAction.current === token;
    setPending(true); setActionError(undefined);
    try { await action(); if (current()) await refresh(); }
    catch (error) {
      if (!current()) return;
      let message = error instanceof Error ? error.message : String(error);
      if (error instanceof ThreadRequestError && error.status === 409) {
        try { await refresh(); }
        catch (failure) { message += `; ${failure instanceof Error ? failure.message : String(failure)}`; }
      }
      if (current()) setActionError(message);
    }
    finally { if (current()) { pendingAction.current = null; setPending(false); } }
  };
  const prepare = () => act(async () => {
    if (!model?.providerId || !model.model || !snapshot.historyPage.head) return;
    const current = lifetime.current;
    const fingerprint = JSON.stringify([identity, snapshot.historyPage.head, snapshot.context.checkpoint?.revision ?? 0, model.providerId, model.catalogModelId ?? model.model, model.thinkingLevel]);
    let key = preparationKeys.current.get(fingerprint);
    if (!key) { key = crypto.randomUUID(); preparationKeys.current.set(fingerprint, key); }
    const job = await api.compact({ ...identity, key, throughId: snapshot.historyPage.head,
      expectedRevision: snapshot.context.checkpoint?.revision ?? 0,
      model: { providerId: model.providerId, modelId: model.catalogModelId ?? model.model,
        thinkingLevel: THINKING_LEVELS.includes(model.thinkingLevel as ThinkingLevel) ? model.thinkingLevel as ThinkingLevel : undefined } });
    if (current === lifetime.current && host === getRuntimeEndpointGeneration()) { preparationKeys.current.delete(fingerprint); setSelected(job.receipt.run_id); }
  });
  const allItems = history.ready ? history.items : snapshot.history;
  const messageKinds = React.useMemo(() => contextMessageKinds(allItems), [allItems]);
  const items = allItems.filter(item => messageFilter === 'all' || messageKinds.get(item.id) === messageFilter);
  const cached = request?.usage.cachedInputTokens, input = request?.completeInputTokens ?? request?.usage.inputTokens;
  const cacheRate = cached != null && cached > 0 && input != null && input > 0 ? cached / input * 100 : undefined;
  return <div ref={scroll} className="context-inspector-scroll"><div className="context-inspector">
    {(error || view?.error || actionError) && <p role="alert" className="context-error">{actionError || error || view?.error}</p>}
    {snapshot.context.policyError && <p role="alert" className="context-error">{t('contextManager.policyUnavailable')}: {snapshot.context.policyError}</p>}
    <header className="context-session-heading">
      {selected && <button className="context-text-button" type="button" onClick={() => setSelected(null)}><Icon name="arrow-left" className="size-3" />{t('contextManager.backCurrent')}</button>}
      <h2>{snapshot.thread.title || t('contextSidebar.session.untitled')}</h2><p>{channel?.name ? `${channel.name} / ${modelName}` : modelName}</p>
    </header>
    {!historical && <ContextBudgetView snapshot={snapshot} inspection={inspection} usage={view?.usage} />}
    <section className="context-state" data-phase={phase}>
      <div className="context-section-caption"><span>{t('contextManager.compaction')}</span><span>{row?.job.request.summary_recipe.mode === 'manual' ? t('contextManager.manual') : t('contextManager.automatic')}</span></div>
      <h3>{phase ? t(contextPhaseLabels[phase]) : t(selected ? 'contextManager.recordPending' : 'contextManager.notTriggered')}{(phase === 'preparing' || phase === 'waiting') && <Icon name="loader-4" className="size-3.5 animate-spin" />}</h3>
      <p>{t(row ? description : selected ? 'contextManager.recordPendingHint' : 'contextManager.notTriggeredHint')}</p>
      {!readOnly && <div className="context-actions">
        {row && phase === 'ready' && <button type="button" disabled={pending} onClick={() => void act(() => api.publishContext(identity, row.run.id))}>{t('contextManager.replaceNow')}</button>}
        {row && (phase === 'preparing' || phase === 'waiting') && <button type="button" disabled={pending || row.run.cancel_requested} onClick={() => void act(() => api.cancelContext(identity, row.run.id))}>{t(row.run.cancel_requested ? 'contextManager.stopping' : 'contextManager.stopPreparation')}</button>}
        {row && (phase === 'preparing' || phase === 'waiting') && ['accepted', 'preparing', 'runnable', 'waiting', 'recovering'].includes(row.run.state) && <button type="button" disabled={pending || row.run.cancel_requested} onClick={() => void act(() => api.resumeContext(identity, row.run.id))}>{t('contextManager.resumePreparation')}</button>}
        {(!row && !selected || phase === 'failed' || phase === 'cancelled' || phase === 'superseded') && <button type="button" disabled={pending || !model?.providerId || !snapshot.historyPage.head} onClick={() => void prepare()}>{t(row ? 'contextManager.prepareAgain' : 'contextManager.prepareNow')}</button>}
      </div>}
    </section>
    <section className="context-summary-section" aria-label={t(historical ? 'contextManager.historicalSummary' : phase === 'ready' ? 'contextManager.candidateSummary' : 'contextManager.activeSummary')}>
      <div className="context-summary-heading"><h3>{t(historical ? 'contextManager.historicalSummary' : phase === 'ready' ? 'contextManager.candidateSummary' : 'contextManager.activeSummary')}</h3>
        {summary && <button type="button" aria-label={t('contextManager.copySummary')} onClick={() => void copy('summary', summary)}><Icon name={copied === 'summary' ? 'check' : 'file-copy'} className="size-3.5" /></button>}</div>
      {phase === 'ready' && <p className="context-section-caption">{t('contextManager.candidateHint')}</p>}
      {summary ? <><div ref={summaryElement} className="context-summary-preview" data-open={summaryOpen} data-overflow={summaryOverflow} tabIndex={summaryOpen ? 0 : undefined}>
        <MarkdownRenderer content={summary} messageId={`context-summary:${row?.run.id ?? snapshot.context.checkpoint?.id}`} />
      </div>{(summaryOverflow || summaryOpen) && <button type="button" className="context-text-button" aria-expanded={summaryOpen} onClick={() => setSummaryOpen(!summaryOpen)}>{t(summaryOpen ? 'contextManager.collapseSummary' : 'contextManager.expandSummary')}<Icon name="arrow-down-s" className={summaryOpen ? 'size-3 rotate-180' : 'size-3'} /></button>}</>
        : <p className="context-empty">{t(jobHistory.loading ? 'common.loading' : 'contextManager.noSummary')}</p>}
    </section>
    {row && <ContextDisclosure title={t('chat.context.summaryProcess')} hint={t(contextPhaseLabels[phase!])} open={processOpen} onOpenChange={setProcessOpen}>
      <div className="context-process">
        {jobHistory.error && <p className="context-error">{jobHistory.error}<button type="button" onClick={() => void jobHistory.refresh()}>{t('chat.context.retry')}</button></p>}
        {jobHistory.page?.previous && <button type="button" className="context-text-button" disabled={jobHistory.loading} onClick={() => void jobHistory.earlier()}>{t('chat.history.loadEarlier')}</button>}
        {jobHistory.parts.map((part, index) => part.type === 'thinking' ? <ChatThinkingBlock key={part.id ?? index} content={part} messageId={part.id ?? `${row.run.id}:${index}`} streaming={phase === 'preparing' || phase === 'waiting'} label={t('chat.context.thinking')} />
          : <div className="context-process-output" key={part.id ?? index}><MarkdownRenderer content={readableContextSummary(part.text)} messageId={part.id ?? `${row.run.id}:${index}`} /></div>)}
        {!jobHistory.parts.length && <p className="context-empty">{t(jobHistory.loading ? 'common.loading' : 'chat.context.noRecordedSteps')}</p>}
      </div>
    </ContextDisclosure>}
    {snapshot.context.jobs.length > 0 && <ContextDisclosure title={t('contextManager.history')} hint={snapshot.context.jobs.length}>
      <div className="context-history">{snapshot.context.jobs.slice().reverse().map((item, index) => <button type="button" key={item.run.id} data-selected={row?.run.id === item.run.id} onClick={() => { setSelected(item.run.id); scroll.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}>
        <Icon name="history" className="size-3" /><span>{t('contextManager.historyItem', { number: snapshot.context.jobs.length - index })}</span><small>{t(contextPhaseLabels[contextJobPhase(item, snapshot)])}</small><Icon name="arrow-right-s" className="size-3" />
      </button>)}</div>
    </ContextDisclosure>}
    {rawPrompt && <ContextDisclosure title={t('contextManager.systemInstructions')}><div className="context-instructions"><MarkdownRenderer content={rawPrompt} messageId={`context-instructions:${snapshot.context.checkpoint?.id}`} /></div></ContextDisclosure>}
    {resources && <ContextDisclosure title={t('contextManager.resources')} hint={resources.skills.length}>
      <div className="context-resources" aria-label={t('contextManager.resources')}>
        <p>{t('contextManager.resourceVersion', { version: resources.id })}</p>
        <p>{t('contextManager.checkpointVersion', { id: resourceCheckpoint!.id, revision: resourceCheckpoint!.revision })}</p>
        <p>{resources.scope.cwd}{resources.scope.sourceIdentity ? ` · ${resources.scope.sourceIdentity}` : ''}</p>
        {resourceCheckpoint!.resources!.source && <p>{[resourceCheckpoint!.resources!.source.mode, resourceCheckpoint!.resources!.source.workspace_id, resourceCheckpoint!.resources!.source.branch_id, resourceCheckpoint!.resources!.source.revision].filter(value => value !== null).join(' · ')}</p>}
        {[resources.system, resources.appendSystem].filter(instruction => instruction !== null).map((instruction, index) => <p key={index}>{instruction!.origin} · {instruction!.reference.path} · {instruction!.reference.domainId} · {instruction!.reference.viewId} · {instruction!.reference.version}</p>)}
        {resources.instructions.map(instruction => <p key={instruction.reference.canonicalId}>{instruction.origin}{instruction.appliesTo ? ` · ${instruction.appliesTo}` : ''} · {instruction.reference.path} · {instruction.reference.domainId} · {instruction.reference.viewId} · {instruction.reference.version}</p>)}
        {resources.instructionScopes.map(scope => <div key={scope.directory}><p>{scope.directory}</p>{scope.instructions.map(instruction => <p key={instruction.reference.canonicalId}>{instruction.origin}{instruction.appliesTo ? ` · ${instruction.appliesTo}` : ''} · {instruction.reference.path} · {instruction.reference.domainId} · {instruction.reference.viewId} · {instruction.reference.version}</p>)}</div>)}
        {resources.skills.map(skill => <div key={skill.id} className="context-resource-skill"><div><span title={skill.reference.path}>{skill.name}</span>
          <p>{skill.origin} · {skill.reference.path} · {skill.reference.domainId} · {skill.reference.viewId} · {skill.reference.version}</p>
          {skill.disableModelInvocation && <p>{t('contextManager.hiddenSkill')}</p>}
          {skill.name.includes(' ') && <p>{t('contextManager.invalidSkillName')}</p>}</div>
          {!readOnly && <button type="button" aria-label={t('contextManager.addSkillCommand', { name: skill.name })} disabled={pending || inputPending || skill.name.includes(' ')} onClick={() => {
            if (pendingAction.current || skill.name.includes(' ') || host !== getRuntimeEndpointGeneration()) return;
            const store = useThreadDraftStore.getState(), draft = store.drafts[draftKey];
            if (draft?.pendingInput || draft?.firstSend?.status === 'sending') return;
            const command = `/skill:${skill.name}`;
            store.patch(draftKey, current => ({ text: current.text === command || current.text.startsWith(command + ' ') ? current.text : `${command} ${current.text}` }));
            setCopied(`skill:${skill.id}`);
          }}>{t(copied === `skill:${skill.id}` ? 'contextManager.addedSkill' : 'contextManager.addSkill')}</button>}
        </div>)}
        {resources.diagnostics.length > 0 && <div aria-label={t('contextManager.resourceDiagnostics')}>{resources.diagnostics.map((diagnostic, index) => <div key={index} className="context-error"><p>{diagnostic.kind}{diagnostic.status ? ` · ${diagnostic.status}` : ''}: {diagnostic.message}</p><p>{diagnostic.location.path} · {diagnostic.location.domainId} · {diagnostic.location.viewId}</p></div>)}</div>}
        {!readOnly && !historical && resourceCheckpoint && <button type="button" className="context-text-button" disabled={pending} onClick={() => void act(() => api.resources.refresh({ ...identity, expectedRevision: resourceCheckpoint.revision }))}>{t('contextManager.refreshResources')}</button>}
      </div>
    </ContextDisclosure>}
    {request && <ContextDisclosure title={t('contextManager.requestUsage')} hint={cacheRate !== undefined ? t('contextManager.cacheRate', { percent: cacheRate.toFixed(1) }) : undefined}>
      <div className="context-request-usage">{([
        ['input', input], ['output', request.usage.outputTokens], ['reasoning', request.usage.reasoningTokens], ['cacheRead', cached], ['cacheWrite', request.usage.cacheWriteTokens],
      ] as const).filter(([key, value]) => key === 'input' || key === 'output' || value != null && value > 0).map(([key, value]) => <div key={key}><span>{t(`contextSidebar.tokens.${key}`)}</span><strong>{value == null ? '—' : value.toLocaleString()}</strong></div>)}</div>
      <p className="context-measurement-note">{t('contextManager.cacheExplanation')}</p>
    </ContextDisclosure>}
    <ContextDisclosure title={t('chat.usage.title')} open={usageOpen} onOpenChange={setUsageOpen}>{usageOpen && <ThreadTokenUsage active={active} identity={identity} />}</ContextDisclosure>
    <ContextDisclosure title={t('contextSidebar.section.rawMessages')} hint={inspection?.counts.total} open={messagesOpen} onOpenChange={setMessagesOpen}>
      <div className="context-message-filters">{(['all', 'user', 'assistant', 'tool', 'mcp'] as const).map(filter => <button type="button" key={filter} aria-pressed={filter === messageFilter} onClick={() => setMessageFilter(filter)}>{filter === 'mcp' ? 'MCP' : t(`contextManager.filter.${filter}`)}</button>)}</div>
      <p className="context-measurement-note">{t('contextManager.historyPreserved')}</p>
      <div className="context-messages">{items.slice().reverse().map(item => {
        const text = historyParts(item.content, item.source).flatMap(part => part.kind === 'text' ? [part.text] : []).join(' ').slice(0, 100);
        const json = expanded[item.id] ? JSON.stringify(item, null, 2) : '';
        const label = messageKinds.get(item.id) === 'mcp' ? 'MCP' : t(item.source === 'user' ? 'contextSidebar.breakdown.user' : item.source === 'assistant' ? 'contextSidebar.breakdown.assistant' : item.source === 'tool' ? 'contextSidebar.breakdown.toolCalls' : 'contextSidebar.breakdown.other');
        return <ContextDisclosure key={item.id} className="context-message" title={`${label}${text ? ': ' + text : ''}`} open={expanded[item.id] ?? false} onOpenChange={open => setExpanded(old => ({ ...old, [item.id]: open }))}>
          {expanded[item.id] && <div className="context-raw"><button type="button" aria-label={t('contextSidebar.actions.copyJson')} onClick={() => void copy(item.id, json)}><Icon name={copied === item.id ? 'check' : 'file-copy'} className="size-3.5" /></button><WorkerHighlightedCode language="json" code={json} style={{ background: 'transparent', margin: 0 }} codeStyle={{ fontSize: 'var(--text-micro)', lineHeight: '1.6', padding: '1rem' }} wrap /></div>}
        </ContextDisclosure>;
      })}</div>
      {history.error && <button type="button" className="context-text-button" onClick={() => void historyWindow.loadEarlier(true)}>{t('chat.context.retry')}</button>}
      <div ref={sentinel} className="h-px" />
    </ContextDisclosure>
  </div></div>;
}
