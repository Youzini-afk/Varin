import { THINKING_LEVELS } from '@varin/protocol';
import { ContextHistoryDialog } from '../conversation/ContextHistoryDialog';
import { ActiveEditorSuggestion } from '../conversation/ActiveEditorSuggestion';
import { MessageHandoff } from '../conversation/messageHandoff';
import { useTimelineViewStore } from '../conversation/timelineViewStore';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { ChatTreeDialog } from '../conversation/ChatTreeDialog';
import { ConversationSurface } from '../conversation/ConversationSurface';
import { ConversationTimeline } from '../conversation/ConversationTimeline';
import { ReferenceNavigationContext, type ReferenceNavigation } from '../conversation/ReferenceNavigation';
import { deliverThreadInput } from '@/lib/agent-runtime/threadInputDelivery';
import { sendThreadDraft } from '@/lib/agent-runtime/sendThreadDraft';
import { useFirstMessagePreview } from './useFirstMessagePreview';
import { AutoReviewBanner } from '@/components/chat/AutoReviewBanner';
import { EditorContextAttachmentChips } from '@/components/workbench/EditorContextAttachmentChips';
import { addContentReference, acknowledgeEditorContextAttachments, getEditorContextAttachmentsRevision, listEditorContextAttachments, subscribeEditorContextAttachments } from '@/lib/agent-editor/attachments';
import { projectEditorContextAttachments } from '@/lib/agent-editor/projection';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { useThreadStore, threadHostKey, threadComposerKey } from '@/stores/useThreadStore';
import { useThreadDraftStore, EMPTY_THREAD_DRAFT, type ThreadPendingInput, type ThreadMaterialAttachment } from '@/stores/useThreadDraftStore';
import { ThreadMaterials } from './ThreadMaterials';
import { ThreadMaterialAttachments } from './ThreadMaterialAttachments';
import { ComputerAutomationSection } from '@/components/thread/ComputerAutomationSection';
import { useComputerAutomation } from '@/stores/useComputerAutomation';
import { ThreadExecutions } from './ThreadExecutions';
import { ThreadMessages } from './ThreadMessages';
import { ThreadFamily } from './ThreadFamily';
import { attachProcessTerminal } from '@/lib/attachProcessTerminal';
import { ThreadChildProfiles } from './ThreadChildProfiles';
import { ThreadPlan } from './ThreadPlan';
import { ThreadGoal } from './ThreadGoal';
import { ThreadFollowups } from './ThreadFollowups';
import { ThreadResearch } from './ThreadResearch';
import { ThreadMemory } from './ThreadMemory';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { ThreadResources } from './ThreadResources';
import { ThreadPermission } from './ThreadPermission';
import { ThreadQuestions } from './ThreadQuestions';
import { ThreadWorkStrips } from './ThreadWorkStrips';
import { ThreadMcpInteractions } from './ThreadMcpInteraction';
import { ThreadSourcePicker } from './ThreadSourcePicker';
import { useThreadRecovery } from './useThreadRecovery';
import { ThreadRecovery } from './ThreadRecovery';
import type { ImageAttachment, InferenceBinding, InferenceReceipt } from '@varin/protocol';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { fileToImageAttachment } from '@/components/chat/composer/imageAttachments';
import { fileToBase64 } from '@/components/chat/composer/fileAttachments';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import React from 'react';
import { createModelConnectionsHttpAPI, threadSourceFailureMessage, ThreadRequestError, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadModel, ThreadModelInfo, ThreadThinkingLevel, ThreadSnapshot, ThreadsAPI, ThreadHistoryPage, ThreadPreparedSource } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { ThreadComposer } from './ThreadComposer';
import { ThreadAgentControls } from './ThreadAgentControls';
import { useThreadWorkFocus } from './useThreadWorkFocus';
import { DraftPresetChips } from '@/components/chat/DraftPresetChips';
import { useUIStore } from '@/stores/useUIStore';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { WorkOverviewControl, type OverviewPeekRow, type OverviewPeekSection } from './WorkOverviewControl';
import { WorkOverviewSection } from './WorkOverviewSection';
import { EMPTY_WORK_OVERVIEW_CHOICES, useWorkOverviewStore } from '@/stores/useWorkOverviewStore';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { cn, formatDirectoryName } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ThreadProjection, type StreamingTextPart } from '@/lib/agent-runtime/thread-projection';
import { ThreadOutput } from './ThreadMedia';
import { ThreadInputQueue } from './ThreadQueuedInput';
import { ChildTasks } from '../conversation/ChildTasks';

// Presentation of owner-defined failure codes; unknown codes keep the owner's safe message.
const runFailureKeys = new Map<string, I18nKey>([
  ['context_candidate_capacity', 'harness.threads.failure.context_candidate_capacity'],
  ['context_capacity', 'harness.threads.failure.context_capacity'],
  ['context_background_disabled', 'harness.threads.failure.context_background_disabled'],
  ['context_compaction_failed', 'harness.threads.failure.context_compaction_failed'],
  ['context_policy_unavailable', 'harness.threads.failure.context_policy_unavailable'],
  ['context_preparation_failed', 'harness.threads.failure.context_preparation_failed'],
  ['execution_failed', 'harness.threads.failure.execution_failed'],
]);

const operationCancelLabel = (operation: ThreadSnapshot['operations'][number]): string => {
  if ((operation.intent as { kind?: string } | null)?.kind === 'inference_request_v1') return 'Stop inference request';
  if (operation.mcp_resource_subscription) return 'Stop resource observation';
  if (operation.host_job?.mcpTask) return 'Request remote task cancellation';
  if (operation.executor === 'dispatch') return 'Cancel child task';
  if (operation.waiting_on?.startsWith('host-job-wait:')
    || (operation.execution_owner?.kind === 'kernel' && (operation.executor === 'wait_child'
      || operation.executor === 'wait_process' || (operation.executor === 'send' && operation.waiting_on !== null)))) {
    return 'Cancel observation wait';
  }
  return 'Cancel operation';
};

function InferenceStatus({ operation }: { operation: ThreadSnapshot['operations'][number] }) {
  const intent = operation.intent as { kind?: string; binding?: InferenceBinding } | null;
  if (intent?.kind !== 'inference_request_v1' || !intent.binding) return null;
  const state = operation.result?.kind === 'control'
    ? operation.result.value as { dispatched: boolean; recovered: boolean; receipt?: InferenceReceipt } : undefined;
  const receipt = state?.receipt;
  const problem = receipt?.problem;
  const preparation = intent.binding.requestKind === 'preparation';
  const explanation = problem === 'receipt_pending' ? preparation
    ? 'The preparation transport has stopped, but its original response is awaiting durable publication.'
    : 'The transport has stopped, but its original response is awaiting durable publication. Usage remains unknown until that receipt is stored.'
    : problem === 'owner_interrupted' ? preparation
      ? 'The original preparation executor was interrupted; this request will not be replayed.'
      : 'The original executor was interrupted. Remote usage is unconfirmed; this request will not be replayed.'
    : problem === 'invalid_response' ? 'The provider response was stored, but its model result was invalid. Check the selected protocol.'
    : problem === 'http_rejected' ? 'The provider rejected this request. Check the original connection and account.'
    : problem === 'transport_failed' ? 'The transport stopped without a complete response. Check the original service before requesting another inference.'
    : problem === 'not_dispatched' ? 'This request was not sent. Check its parent operation, Goal and current access before starting a new inference.'
    : problem === 'cancelled' ? 'Cancellation was requested. Any usage already received remains accounted.' : null;
  return <section aria-label="Inference request" className="space-y-1 text-xs text-muted-foreground">
    <p>{intent.binding.purpose} · {intent.binding.providerId} / {intent.binding.modelId} · {preparation ? 'Preparation' : 'Model compute'}</p>
    <p>{receipt?.requestStarted === false ? 'Not sent' : receipt?.requestStarted === true ? 'Transport started' : state?.dispatched ? 'Dispatch recorded; sending unconfirmed' : 'Awaiting dispatch'}
      {' · '}{receipt?.localExecutorStopped ? 'Local executor stopped' : 'Local executor stop unconfirmed'}</p>
    {preparation ? <p>Tokenization or template preparation; no model inference usage.</p>
      : <p>Input tokens: {receipt?.usage.inputTokens ?? 'unknown'} · Output tokens: {receipt?.usage.outputTokens ?? 'unknown'}</p>}
    {!preparation && receipt?.providerCompleted && receipt.usage.measurement === 'missing'
      && <p>The response does not establish input/output token usage or cost.</p>}
    {explanation && <p role="status">{explanation}</p>}
  </section>;
}

function McpTaskStatus({ operation }: { operation: ThreadSnapshot['operations'][number] }) {
  const job = operation.host_job;
  const link = job?.mcpTask;
  if (!link || job.binding.subject.kind !== 'mcp') return null;
  const problem = link.problem;
  const problemText = problem?.kind === 'owner' ? 'The original MCP connection or account is unavailable. Restore that connection to observe this task.'
    : problem?.kind === 'expired' ? 'The remote task retention period has elapsed. Its execution may still be running.'
    : problem?.kind === 'unsupported' ? problem.stage === 'cancel' ? 'This server does not support task cancellation. Check the original service.'
      : problem.stage === 'interaction' ? 'This task needs an interaction that this client does not support. Check the original service.'
      : 'The original service does not support this task operation. Check its task capabilities before retrying.'
    : problem?.kind === 'protocol' ? 'The server could not provide a valid task response. Check the original service; the task identity is retained.'
    : problem?.kind === 'transport' ? 'The original MCP connection could not be reached. Check its connection; observation can resume when it is available.' : null;
  return <section aria-label="Remote MCP task" className="space-y-1 text-xs text-muted-foreground">
    <p>{job.binding.subject.endpoint.server} · remote task {link.task.taskId}</p>
    <p>Remote status: {link.task.status.replaceAll('_', ' ')} · {link.resultReady ? 'Result stored' : 'Result not received'}</p>
    <p>{operation.external_receipt?.executor_stopped ? 'Executor stop confirmed' : 'Executor stop unconfirmed'}
      {operation.cancel_requested && ' · Cancellation requested'}</p>
    {link.task.status === 'cancelled' && !operation.external_receipt?.executor_stopped && <p>The server acknowledged cancellation. This does not prove execution has stopped.</p>}
    {link.task.status === 'input_required' && <p>The server is waiting for an interaction on the original task result stream.</p>}
    {link.availability === 'unavailable' && <p>Current task observation unavailable</p>}
    {problemText && <p role="status">{problemText} · {problem!.stage}{problem!.rpcCode !== undefined ? ` · RPC ${problem!.rpcCode}` : ''}</p>}
  </section>;
}

function McpResourceStatus({ operation }: { operation: ThreadSnapshot['operations'][number] }) {
  const subscription = operation.mcp_resource_subscription;
  if (!subscription) return null;
  const availability = {
    pending: 'Subscription acknowledgement pending',
    active: 'Resource observation active',
    gap: 'Resource observation gap: some updates may have been missed',
    unavailable: 'Resource observation unavailable',
    closed: 'Resource observation closed',
  }[subscription.availability];
  const cleanup = {
    not_requested: 'Remote cleanup not requested',
    shared: 'Remote subscription retained for other observers',
    acknowledged: 'Remote unsubscribe acknowledged',
    unknown: 'Remote cleanup unconfirmed',
  }[subscription.remoteCleanup];
  return <section aria-label="MCP resource observation" className="space-y-1 text-xs text-muted-foreground">
    <p>{subscription.binding.endpoint.server} · {subscription.binding.uri}</p>
    <p>{availability}</p>
    <p>{subscription.localReleased ? 'Local observation released' : 'Local observation retained'} · {cleanup}</p>
    {subscription.availability === 'gap' && <p>Read the resource explicitly if you need its current contents.</p>}
    {subscription.problem && <p role="status">{subscription.availability === 'closed' && subscription.localReleased
      ? 'Observation has ended locally. Check the original service if remote cleanup needs attention.'
      : 'Check the original MCP connection and resource access. Updates do not read the resource automatically.'}</p>}
  </section>;
}

function canCancelOperation(operation: ThreadSnapshot['operations'][number], waitingOn?: string | null): boolean {
  const subscription = operation.mcp_resource_subscription;
  if (subscription) return subscription.availability !== 'closed' || !subscription.localReleased;
  const task = operation.host_job?.mcpTask;
  return task ? !operation.cancel_requested && (task.task.status === 'working' || task.task.status === 'input_required')
    : operation.phase !== 'terminal' && (operation.executor !== 'ask_user' || waitingOn === operation.waiting_on);
}

const resourceErrorMessages = new Map([
  ['resource-missing', 'This skill or resource is missing from the current snapshot. Refresh instructions and skills, then try again.'],
  ['resource-invalid', 'This skill or resource could not be prepared. Check the skill definition or command, then try again.'],
  ['resource-denied', 'Access to this skill or resource was denied. Check workspace permissions and project trust before retrying.'],
  ['resource-unavailable', 'This skill or resource is unavailable right now. Refresh instructions and skills, then try again.'],
  ['resource-stale', 'This skill or resource has changed. Refresh instructions and skills, then try again.'],
  ['resource-cancelled', 'Skill or resource preparation was cancelled. Try again when ready.'],
]);

export function ThreadConversation({ api, identity, onBranchCreated, initialWorkspacePath, preferredModel, onWorkChanged, readOnly = false, messageHandoff }: { messageHandoff?: MessageHandoff; onWorkChanged?: () => void; preferredModel?: ThreadModel | null; readOnly?: boolean; api: ThreadsAPI; identity: ThreadIdentity; onBranchCreated?: (identity: ThreadIdentity) => void; initialWorkspacePath?: string }) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const draftKey = threadComposerKey(threadHostKey(), identity);
  const viewScope = React.useMemo(() => ({ api, host, draftKey, readOnly }), [api, host, draftKey, readOnly]);
  const referenceNavigation = React.useMemo<ReferenceNavigation>(() => ({ identity: { runtime: identity.runtime, threadId: identity.threadId, branchId: identity.branchId } }), [identity.runtime, identity.threadId, identity.branchId, host]);
  const currentViewScope = React.useRef(viewScope);
  currentViewScope.current = viewScope;
  const [handoff] = React.useState(() => messageHandoff ?? new MessageHandoff());
  const reducedMotion = usePrefersReducedMotion();
  React.useLayoutEffect(() => { handoff.select(String(host), draftKey, !readOnly, reducedMotion); }, [handoff, host, draftKey, readOnly, reducedMotion]);
  React.useLayoutEffect(() => () => { if (!messageHandoff) handoff.dispose(); }, [handoff, messageHandoff]);
  const draft = useThreadDraftStore(state => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const setText = React.useCallback((value: React.SetStateAction<string>) => useThreadDraftStore.getState().patch(draftKey, current => ({ text: typeof value === 'function' ? value(current.text) : value })), [draftKey]);
  const setImages = React.useCallback((value: React.SetStateAction<ImageAttachment[]>) => useThreadDraftStore.getState().patch(draftKey, current => ({ images: typeof value === 'function' ? value(current.images) : value })), [draftKey]);
  const setMaterials = React.useCallback((value: React.SetStateAction<ThreadMaterialAttachment[]>) => useThreadDraftStore.getState().patch(draftKey, current => ({ materials: typeof value === 'function' ? value(current.materials) : value })), [draftKey]);
  const setPreparedSource = React.useCallback((preparedSource: ThreadPreparedSource | null) => useThreadDraftStore.getState().patch(draftKey, { preparedSource }), [draftKey]);
  const setInputMode = React.useCallback((inputMode: 'boundary' | 'interrupt' | 'next_run') => useThreadDraftStore.getState().patch(draftKey, { inputMode }), [draftKey]);
  const { text, images, materials, preparedSource, inputMode } = draft;
  React.useSyncExternalStore(subscribeEditorContextAttachments, getEditorContextAttachmentsRevision, () => 0);
  const editorContext = listEditorContextAttachments(threadHostKey(), draftKey);
  const inlineBuckets = useInlineCommentDraftStore(state => state.drafts);
  const inlineContext = React.useMemo(() => Object.entries(inlineBuckets).flatMap(([key, drafts]) => {
    const captured = drafts.filter(item => item.sessionKey === draftKey);
    return captured.length ? [{ key, drafts: captured }] : [];
  }), [inlineBuckets, draftKey]);
  const inlineDrafts = inlineContext.flatMap(bucket => bucket.drafts);
  const providerId = draft.model?.providerId ?? '';
  const modelId = draft.model?.modelId ?? '';
  const thinkingLevel = draft.model?.thinkingLevel ?? 'off';
  const temperature = draft.model?.temperature;
  const patchModel = React.useCallback((patch: Partial<ThreadModel>) => useThreadDraftStore.getState().patch(draftKey, current => ({ model: { providerId: '', modelId: '', ...current.model, ...patch } })), [draftKey]);
  const setProviderId = React.useCallback((providerId: string) => patchModel({ providerId }), [patchModel]);
  const setModelId = React.useCallback((modelId: string) => patchModel({ modelId }), [patchModel]);
  const setThinkingLevel = React.useCallback((thinkingLevel: ThreadThinkingLevel) => patchModel({ thinkingLevel }), [patchModel]);
  const pendingInput = React.useMemo(() => ({
    get current() { return useThreadDraftStore.getState().drafts[draftKey]?.pendingInput; },
    set current(pendingInput: ThreadPendingInput | undefined) { useThreadDraftStore.getState().patch(draftKey, { pendingInput }); },
  }), [draftKey]);
  const fileInput = React.useRef<HTMLInputElement | null>(null);
  const pdfInput = React.useRef<HTMLInputElement | null>(null);
  const fileReadGeneration = React.useRef(0);
  const fileRead = React.useRef<AbortController | null>(null);
  const [readingFiles, setReadingFiles] = React.useState(false);
  const [preparingSource, setPreparingSource] = React.useState(false);
  const [snapshotState, setSnapshot] = React.useState<ThreadSnapshot>();
  const snapshotHost = React.useRef<number | undefined>(undefined);
  const [historyView, setHistoryView] = React.useState<ThreadHistoryPage | null>(null);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const historyGeneration = React.useRef(0);
  const identityGeneration = React.useRef(0);
  const forkKeys = React.useRef(new Map<string, string>());
  const compactionKeys = React.useRef(new Map<string, string>());
  const [progress, setProgress] = React.useState<StreamingTextPart[]>([]);
  const [streamingTools, setStreamingTools] = React.useState<import('@/lib/agent-runtime/thread-projection').StreamingToolCall[]>([]);
  const messageInput = React.useRef<ComposerEditorHandle | null>(null);
  const appliedModelPreference = React.useRef<string | undefined>(undefined);
  const [models, setModels] = React.useState<ThreadModelInfo[]>([]);
  const [modelError, setModelError] = React.useState<string>();
  const [defaultsVersion, refreshDefaults] = React.useReducer(version => version + 1, 0);
  React.useEffect(() => {
    let active = true; let request = 0;
    setModels([]); setModelError(undefined);
    const refresh = () => {
      const current = ++request;
      void api.listModels().then(value => {
        if (active && current === request) { setModels(value); setModelError(undefined); }
      }, () => { if (active && current === request) setModelError(t('settings.agents.modelsUnavailable')); });
    };
    refresh();
    const unsubscribe = subscribeVarinEvents(event => {
      if (event.type === 'stream-ready' || event.type === 'settings-changed' && event.owner === 'agent-settings' && !event.ids.length) refreshDefaults();
      if (event.type === 'stream-ready' || event.type === 'settings-changed' && event.owner === 'agent-settings'
        && event.ids.some(id => id === 'model-channels' || id === 'model-credentials')) refresh();
    });
    return () => { active = false; unsubscribe(); };
  }, [api, host, t]);
  const [error, setError] = React.useState<string>();
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [contextRunId, setContextRunId] = React.useState<string>();
  const [actionPending, setPending] = React.useState(false);
  const pendingAction = React.useRef<object | null>(null);
  const projection = React.useRef<ThreadProjection | undefined>(undefined);
  React.useEffect(() => {
    identityGeneration.current += 1; forkKeys.current.clear(); compactionKeys.current.clear();
    historyGeneration.current += 1; setHistoryView(null); setHistoryLoading(false);
    setPreparingSource(false);
    pendingAction.current = null; setPending(false); setError(undefined);
    setSnapshot(undefined); setProgress([]); setHistoryOpen(false); setContextRunId(undefined); setReadingFiles(false); fileReadGeneration.current += 1;
    fileRead.current?.abort(); fileRead.current = null;
    const view = new ThreadProjection(api, identity, value => { snapshotHost.current = host; handoff.observe(value); setSnapshot(value); }, value => setError(value instanceof Error ? value.message : 'Thread unavailable'), setProgress, setStreamingTools);
    projection.current = view; view.start();
    return () => { identityGeneration.current += 1; historyGeneration.current += 1; fileReadGeneration.current += 1; fileRead.current?.abort(); fileRead.current = null; view.close(); };
  }, [api, identity, host, handoff]);
  const snapshot = snapshotHost.current === host && snapshotState?.identity.threadId === identity.threadId && snapshotState?.identity.branchId === identity.branchId ? snapshotState : undefined;
  React.useEffect(() => {
    if (!snapshot || historyView || typeof document === 'undefined') return;
    const acknowledge = () => {
      if (document.visibilityState !== 'hidden' && host === getRuntimeEndpointGeneration()) {
        void useThreadStore.getState().markRead(identity.threadId, snapshot.thread.activity_cursor).catch(() => {});
      }
    };
    acknowledge();
    document.addEventListener('visibilitychange', acknowledge);
    return () => document.removeEventListener('visibilitychange', acknowledge);
  }, [snapshot, historyView, host, identity.threadId]);
  const workRevision = snapshot ? JSON.stringify([snapshot.activeRun?.id, snapshot.activeRun?.state,
    snapshot.children?.map(child => [child.child_thread_id, child.state])]) : null;
  React.useEffect(() => { if (workRevision) onWorkChanged?.(); }, [workRevision, onWorkChanged]);
  const branch = snapshot?.thread.branches.find(value => value.branch_id === identity.branchId);
  const run = snapshot?.activeRun ?? branch?.latest_run;
  const runFailure = snapshot?.runFailure?.runId === run?.id ? snapshot?.runFailure : null;
  const runFailureKey = runFailure && runFailureKeys.get(runFailure.code);
  const samplingConfiguration = (snapshot?.modelSelection.active?.configuration ?? run?.configuration) as
    { providerId?: string; model?: string; thinkingLevel?: ThreadThinkingLevel; catalogModelId?: string; modelOptions?: { temperature?: number } } | undefined;
  const samplingModel: ThreadModel | undefined = samplingConfiguration?.providerId && samplingConfiguration.model ? {
    providerId: samplingConfiguration.providerId, modelId: samplingConfiguration.catalogModelId ?? samplingConfiguration.model,
    ...(samplingConfiguration.thinkingLevel === undefined ? {} : { thinkingLevel: samplingConfiguration.thinkingLevel }),
    ...(samplingConfiguration.modelOptions?.temperature === undefined ? {} : { temperature: samplingConfiguration.modelOptions.temperature }),
  } : undefined;
  const active = Boolean(branch?.active_run_id);
  const computer = useComputerAutomation(identity, api.computer, branch?.active_run_id);
  const hasComputer = Boolean(computer.error || computer.state?.active || computer.state && computer.state.status !== 'enabled' || computer.state?.cleanups.length || computer.state?.leases.length || computer.state?.requests.length || computer.activities.length);
  const delegated = Boolean(snapshot?.delegatedExecutions?.length);
  const preparingDelegation = snapshot?.delegatedExecutions?.some(execution => !execution.receipt && !execution.report && !execution.cancel_requested) ?? false;
  React.useEffect(() => { if (delegated && inputMode === 'next_run') setInputMode('boundary'); }, [delegated, inputMode, setInputMode]);
  const launch = snapshot?.launch?.run_id === run?.id ? snapshot?.launch : null;
  const workFocus = useThreadWorkFocus(draftKey, draft.workspacePath ?? launch?.selection.source?.live_root?.canonicalRoot ?? initialWorkspacePath, launch?.selection.agent?.workFocus, Boolean(snapshot));
  const agent = { profileId: null, workFocus };
  const pause = run?.state === 'waiting' && launch?.pause?.wait_id === run.waiting_on ? launch.pause : null;
  const policy = snapshot?.policySelection;
  const policyUpdate = policy?.desired && policy.desired.run_id === run?.id ? policy.desired : null;
  const policyUpdatePending = policyUpdate?.status === 'preparing' || policyUpdate?.status === 'ready';
  const policyIncompatible = policyUpdate?.status === 'failed' && policyUpdate.failure === 'policy_state_incompatible';
  const acceptsImages = active || delegated ? (run?.configuration as { acceptsImages?: boolean } | undefined)?.acceptsImages
    : models.find(model => model.providerId === providerId && model.modelId === modelId)?.acceptsImages;
  const projectedText = projectEditorContextAttachments(appendInlineComments(text, inlineDrafts), editorContext, { includeImages: acceptsImages === true });
  const requestImages = React.useMemo(() => [...images, ...(acceptsImages === true ? editorContext.flatMap(item => item.reference?.image
    ? [{ mimeType: item.reference.image.mimeType, data: item.reference.image.data }] : []) : [])], [images, acceptsImages, editorContext]);
  React.useEffect(() => {
    if (active || delegated || draft.firstSend) return;
    const levels = models.find(model => model.providerId === providerId && model.modelId === modelId)?.thinkingLevels;
    if (levels?.length && !levels.includes(thinkingLevel)) setThinkingLevel(levels[0]!);
  }, [active, delegated, draft.firstSend, models, providerId, modelId, thinkingLevel, setThinkingLevel]);
  React.useEffect(() => {
    const config = (snapshot?.modelSelection.desired?.configuration ?? run?.configuration) as { providerId?: string; model?: string; thinkingLevel?: ThreadThinkingLevel; catalogModelId?: string } | undefined;
    if (config?.providerId && config.model && (active || !providerId && preferredModel === undefined)) { setProviderId(config.providerId); setModelId(config.catalogModelId ?? config.model); setThinkingLevel(config.thinkingLevel ?? 'off'); }
  }, [run?.configuration, snapshot?.modelSelection.desired, active, providerId, preferredModel, setProviderId, setModelId, setThinkingLevel]);
  React.useEffect(() => {
    if (!snapshot || preferredModel === undefined) return;
    const key = JSON.stringify([host, identity.threadId, identity.branchId, preferredModel]);
    if (appliedModelPreference.current === key) return;
    appliedModelPreference.current = key;
    // Active work consumes the original desired-selection owner. Idle drafts may follow a
    // changed Bot profile even when their latest Run was cancelled; later renders preserve edits.
    if (!active) { setProviderId(preferredModel?.providerId ?? ''); setModelId(preferredModel?.modelId ?? ''); setThinkingLevel(preferredModel?.thinkingLevel ?? 'off'); }
  }, [snapshot, active, host, identity.threadId, identity.branchId, preferredModel, setProviderId, setModelId, setThinkingLevel]);
  const needsDefaultModel = Boolean(snapshot && !run && preferredModel === undefined && !providerId && !modelId);
  React.useEffect(() => {
    if (!needsDefaultModel) return;
    const controller = new AbortController();
    const workspacePath = draft.workspacePath ?? initialWorkspacePath;
    void createModelConnectionsHttpAPI(host).readSettings(workspacePath, controller.signal).then(settings => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      const effective = { ...settings.global, ...(settings.projectTrusted ? settings.project : {}) };
      if (typeof effective.defaultProvider !== 'string' || typeof effective.defaultModel !== 'string') return;
      useThreadDraftStore.getState().patch(draftKey, current => {
        if (current.model?.providerId || current.model?.modelId || current.workspacePath !== draft.workspacePath) return {};
        const thinking = effective.defaultThinkingLevel;
        return { model: { providerId: effective.defaultProvider as string, modelId: effective.defaultModel as string,
          ...(typeof thinking === 'string' && (THINKING_LEVELS as readonly string[]).includes(thinking) ? { thinkingLevel: thinking as ThreadThinkingLevel } : {}) } };
      });
    }).catch(failure => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [needsDefaultModel, host, draftKey, draft.workspacePath, initialWorkspacePath, defaultsVersion]);
  const act = async (work: () => Promise<unknown>, interrupt = false) => {
    if (readOnly || currentViewScope.current !== viewScope || pendingAction.current && !interrupt) return;
    const action = {}; pendingAction.current = action;
    const generation = identityGeneration.current;
    const current = () => generation === identityGeneration.current && host === getRuntimeEndpointGeneration() && pendingAction.current === action;
    setPending(true); setError(undefined); useThreadDraftStore.getState().patch(draftKey, { sendError: undefined });
    try { await work(); if (current()) await projection.current?.refresh(); }
    catch (value) {
      if (!current()) return;
      if (value instanceof ThreadRequestError && value.status === 409) await projection.current?.refresh();
      if (!current()) return;
      const resourceError = value instanceof ThreadRequestError ? threadSourceFailureMessage(value.code) ?? resourceErrorMessages.get(value.code) : undefined;
      setError(resourceError ?? (value instanceof ThreadRequestError && ['kernel-frame-too-large', 'http-body-too-large'].includes(value.code)
        ? 'These images exceed the current transport request size. Remove or resize an image and retry; your attachments are still here.'
        : value instanceof ThreadRequestError && value.code === 'model-images-unsupported' ? 'The selected model does not accept images. Choose an image-capable model or remove the images.'
        : value instanceof Error ? value.message : 'Thread request failed'));
    }
    finally { if (current()) { pendingAction.current = null; setPending(false); } }
  };
  const openProcessTerminal = async (operationId: string) => {
    const generation = identityGeneration.current;
    const terminal = await api.processes!.openTerminal({ ...identity, operationId });
    if (generation === identityGeneration.current && host === getRuntimeEndpointGeneration()) {
      if (terminal.operationId !== operationId) throw new Error('PROCESS_IDENTITY_MISMATCH');
      attachProcessTerminal(terminal.cwd, terminal.sessionId, 'Agent process', terminal.resourceOwner, {
        identity: { ...identity }, operationId, processId: terminal.processId, endpointGeneration: host,
      });
    }
  };
  const addFiles = async (files: File[]) => {
    // DOM events can arrive twice before React publishes the disabled state. An uncertain
    // input keeps its exact retained snapshots, so selecting again cannot retransmit them.
    if (!files.length || readOnly || fileRead.current || pendingAction.current || pendingInput.current || useThreadDraftStore.getState().drafts[draftKey]?.firstSend) return;
    const generation = fileReadGeneration.current;
    const controller = new AbortController(); fileRead.current = controller;
    const current = () => !controller.signal.aborted && generation === fileReadGeneration.current
      && host === getRuntimeEndpointGeneration() && fileRead.current === controller;
    const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    setReadingFiles(true); setError(undefined);
    try {
      if (files.some(file => !isPdf(file) && !file.type.startsWith('image/'))) throw new Error(t('chat.fileAttachment.unsupportedType'));
      if (acceptsImages === false && files.some(file => !isPdf(file))) throw new Error('The selected model does not accept images');
      for (const file of files) {
        if (!current()) return;
        if (isPdf(file)) {
          const data = await fileToBase64(file);
          if (!current()) return;
          const result = await api.materials.upload(identity, { filename: file.name, mimeType: 'application/pdf', data }, controller.signal);
          if (!current()) return;
          const retained = result.status === 'ok' ? result.sourceSnapshot ?? result.snapshot : undefined;
          if (!retained?.snapshotId || retained.document?.kind !== 'pdf') throw new Error(t('chat.fileAttachment.pdfNotRetained'));
          const material = { snapshotId: retained.snapshotId, filename: file.name, sourceHash: retained.document.source?.contentHash };
          setMaterials(previous => previous.some(item => item.snapshotId === material.snapshotId) ? previous : [...previous, material]);
        } else {
          const image = await fileToImageAttachment(file);
          if (!current()) return;
          setImages(previous => [...previous, image]);
        }
      }
    } catch (value) { if (current()) setError(value instanceof Error ? value.message : t('chat.fileAttachment.toast.attachFailed')); }
    finally { if (current()) { fileRead.current = null; setReadingFiles(false); } }
  };
  const selectModel = (provider: string, model: string, thinking: ThreadThinkingLevel) => {
    if (active && run) {
      void act(()=>api.selectModel({...identity,runId:run.id,key:crypto.randomUUID(),model:{providerId:provider,modelId:model,thinkingLevel:thinking}}));
    } else {setProviderId(provider);setModelId(model);setThinkingLevel(thinking);}
  };
  const addSkill = (name: string) => {
    if (pendingAction.current || name.includes(' ')) return;
    const command = `/skill:${name}`;
    setText(current => current === command || current.startsWith(`${command} `) ? current : `${command} ${current}`);
    messageInput.current?.focus();
  };
  const returnToLatest = () => { historyGeneration.current += 1; setHistoryView(null); setHistoryLoading(false); };
  const recovery = useThreadRecovery({ api, identity, host, snapshot, disabled: readOnly || active || actionPending || Boolean(draft.pendingInput), onRecovered: async editor => {
    returnToLatest(); pendingInput.current = undefined; setPreparedSource(null);
    if (editor.editorText !== undefined) setText(editor.editorText);
    if (editor.editorImages !== undefined) setImages(editor.editorImages);
    await projection.current?.refresh();
  } });
  const pending = actionPending || recovery.blocked || draft.firstSend?.status === 'sending';
  const loadEarlier = async () => {
    if (!snapshot) return;
    const current = historyView ?? { ...snapshot.historyPage, items: snapshot.history };
    if (!current.head || !current.previous) return;
    const generation = ++historyGeneration.current;
    setHistoryLoading(true); setError(undefined);
    try {
      const page = await api.historyPage(identity, { headId: current.head, beforeId: current.previous });
      if (generation === historyGeneration.current) setHistoryView({ head: current.head, previous: page.previous, items: [...page.items, ...current.items] });
    } catch (value) { if (generation === historyGeneration.current) setError(value instanceof Error ? value.message : 'Earlier history is unavailable'); }
    finally { if (generation === historyGeneration.current) setHistoryLoading(false); }
  };
  const forkFrom = async (headId: string) => {
    const generation = identityGeneration.current;
    let key = forkKeys.current.get(headId);
    if (!key) { key = crypto.randomUUID(); forkKeys.current.set(headId, key); }
    await act(async () => {
      const created = await api.fork({ ...identity, key, headId });
      if (generation === identityGeneration.current) { forkKeys.current.delete(headId); onBranchCreated?.(created); }
    });
  };
  const compactThrough = async (throughId: string) => {
    if (!snapshot) return;
    const generation = identityGeneration.current;
    const expectedRevision = snapshot.context.checkpoint?.revision ?? 0;
    const fingerprint = JSON.stringify([throughId, expectedRevision, providerId, modelId, thinkingLevel]);
    let key = compactionKeys.current.get(fingerprint);
    if (!key) { key = crypto.randomUUID(); compactionKeys.current.set(fingerprint, key); }
    await act(async () => {
      await api.compact({ ...identity, key, throughId, expectedRevision, model: { providerId, modelId, thinkingLevel } });
      if (generation === identityGeneration.current) compactionKeys.current.delete(fingerprint);
    });
  };
  const visibleHistory = historyView?.items ?? snapshot?.history ?? [];
  const firstMessage = useFirstMessagePreview(draftKey, Boolean(snapshot?.historyPage.head), handoff);
  const previousHistory = historyView ? historyView.previous : snapshot?.historyPage.previous;
  const memorySelection = getRegisteredRuntimeAPIs()?.bots?.selection;
  const submissionFingerprint = () => JSON.stringify([identity.threadId, identity.branchId, projectedText, requestImages, materials, providerId, modelId, thinkingLevel, inputMode, preparedSource?.source, agent]);
  const sourceCannotBeApplied = active && Boolean(preparedSource) && !pendingInput.current;
  const sendDisabled = pending || (!draft.pendingInput && (!snapshot || preparingDelegation || preparingSource || sourceCannotBeApplied || readingFiles
    || (images.length > 0 && acceptsImages === false)
    || (!text.trim() && !images.length && !materials.length && !inlineDrafts.length && !editorContext.length)
    || (!active && (delegated ? !api.collaboration || !run : !providerId || !modelId))));
  const overviewKey = draftKey;
  const choices = useWorkOverviewStore(state => state.bySession[overviewKey] ?? EMPTY_WORK_OVERVIEW_CHOICES);
  const disclosure = useWorkOverviewStore(state => state.setDisclosure);
  const contentOwner = `${host}:${draftKey}`;
  const [overviewContent, setOverviewContent] = React.useState<{ owner: string; plan?: boolean; followups?: boolean; research?: boolean; memory?: boolean }>({ owner: '' });
  const [focusedOverview, setFocusedOverview] = React.useState<{ owner: string; section: OverviewPeekSection }>();
  const reportOverviewContent = React.useMemo(() => {
    const report = (key: 'plan' | 'followups' | 'research' | 'memory') => (present: boolean) => setOverviewContent(previous => {
      const current = previous.owner === contentOwner ? previous : { owner: contentOwner };
      return current[key] === present ? current : { ...current, [key]: present };
    });
    return { plan: report('plan'), followups: report('followups'), research: report('research'), memory: report('memory') };
  }, [contentOwner]);
  const content = overviewContent.owner === contentOwner ? overviewContent : undefined;
  const focused = focusedOverview?.owner === contentOwner ? focusedOverview.section : undefined;
  const showOverview = (section: OverviewPeekSection) => {
    setFocusedOverview({ owner: contentOwner, section });
    disclosure(overviewKey, 'overview', true); disclosure(overviewKey, section, true);
  };
  const checkpoint = snapshot?.context.checkpoint;
  const resources = checkpoint?.resources?.snapshot;
  const visibleOperations = snapshot?.operations.filter(operation => operation.id !== pause?.action_id) ?? [];
  const hasRecovery = Boolean(recovery.notice || recovery.error || recovery.unavailable || recovery.combinedUnavailable
    || recovery.operation || recovery.canRetry || recovery.canUndo || recovery.savedOperations.length);
  const hasSummaries = Boolean(checkpoint?.proposal.summary.trim() || snapshot?.context.jobs.length);
  const sections = {
    plan: Boolean(snapshot?.goals.length || content?.plan),
    threads: Boolean(snapshot?.children?.length || snapshot?.childExecutions?.length || snapshot?.delegatedExecutions?.length || snapshot?.thread.parent_thread_id),
    outputs: Boolean(visibleOperations.length || snapshot?.followups.some(item => item.actor.kind !== 'goal') || content?.followups || hasRecovery),
    sources: Boolean(preparedSource || draft.workspacePath || launch?.selection.source || content?.research || resources?.system
      || resources?.appendSystem || resources?.instructions.length || resources?.instructionScopes.some(scope => scope.instructions.length)
      || resources?.skills.length || resources?.diagnostics.length),
    memory: Boolean(content?.memory || checkpoint?.personalization?.memorySnapshot.memories.length || hasSummaries),
    computer: hasComputer,
  };
  const overviewRows: OverviewPeekRow[] = [];
  if (sections.plan) overviewRows.push({ id: 'plan', section: 'plan', icon: 'task', label: t('harness.overview.plan') });
  if (sections.threads) overviewRows.push({ id: 'children', section: 'threads', icon: 'git-branch', label: t('harness.overview.threads'), value: snapshot?.children?.length || undefined });
  if (sections.outputs) overviewRows.push({ id: 'operations', section: 'outputs', icon: 'list-check-2', label: t('harness.overview.outputs'), value: visibleOperations.length || undefined });
  if (sections.sources) overviewRows.push({ id: 'sources', section: 'sources', icon: 'folder', label: t('harness.overview.sources') });
  if (sections.memory) overviewRows.push({ id: 'memory', section: 'memory', icon: 'book-open', label: t('harness.overview.memory') });
  if (sections.computer) overviewRows.push({ id: 'computer', section: 'computer', icon: 'computer', label: t('computer.automation.title') });
  const empty = Boolean(snapshot && !visibleHistory.length && !progress.length && !active && !firstMessage.message && !pending && !draft.pendingInput);
  const emptyWorkspacePath = preparedSource?.path ?? draft.workspacePath ?? launch?.selection.source?.live_root?.canonicalRoot;

  const overview = <WorkOverviewControl open={choices.overview ?? false} compactOpen={choices.compact ?? false}
    attention={Boolean(run?.waiting_on || recovery.unavailable || error)} rows={overviewRows}
    onOpenChange={open => { setFocusedOverview(undefined); disclosure(overviewKey, 'overview', open); }}
    onCompactChange={open => { setFocusedOverview(undefined); disclosure(overviewKey, 'compact', open); }}
    onSelect={section => showOverview(section)}>
    <div className="border-b border-border/50 px-4 py-3 typography-ui-label font-medium">{t('harness.overview.title')}</div>
    <div className="thread-work-overview min-h-0 overflow-y-auto">
      {!overviewRows.length && !focused && <p className="px-3 py-4 typography-meta text-muted-foreground">{t('harness.overview.empty')}</p>}
      <WorkOverviewSection visible={sections.plan || focused === 'plan'} title={t('harness.overview.plan')} icon="task" open={choices.plan ?? false} onOpenChange={open => disclosure(overviewKey, 'plan', open)}>
      {!readOnly && snapshot && <ThreadGoal api={api.goals} identity={identity} goals={snapshot.goals} sourceRunId={run?.id} refresh={async () => { await projection.current?.refresh(); }} />}
      {!readOnly && api.plan && <ThreadPlan api={api.plan} identity={identity} contextRevision={snapshot?.context.checkpoint?.revision} onContentChange={reportOverviewContent.plan} />}
      </WorkOverviewSection>
      <WorkOverviewSection visible={sections.threads || focused === 'threads'} title={t('harness.overview.threads')} icon="git-branch" open={choices.threads ?? false} onOpenChange={open => disclosure(overviewKey, 'threads', open)}>
      {snapshot && <ChildTasks api={api} identity={identity} children={snapshot.children ?? []}
        executions={snapshot.childExecutions ?? []} activity={snapshot.childActivity} pending={pending}
        cancel={!readOnly && api.collaboration ? operationId => act(() => api.collaboration!.cancelChild(identity, operationId)) : undefined} />}
      {!readOnly && snapshot && api.collaboration && (run || snapshot.children?.length || delegated) && <Button variant="ghost" size="sm" disabled={pending}
        onClick={() => void act(() => api.collaboration!.cancelTree(identity), true)}>{t('harness.threads.stopAll')}</Button>}
      {launch && <ThreadChildProfiles launch={launch.selection} />}
      {api.family && <ThreadFamily api={api.family} mediaRead={api.mediaRead} identity={identity} />}
      {!readOnly && api.messages && <ThreadMessages api={api.messages} family={api.family} identity={identity} eventCursor={snapshot?.eventCursor} cancelObservation={pending ? undefined : operationId => act(() => api.cancelOperation(operationId), true)} />}
    {delegated && <div className="mx-auto w-full max-w-3xl px-4"><ThreadExecutions key={`${host}:${identity.threadId}:${identity.branchId}`} api={api} identity={identity} executions={snapshot?.delegatedExecutions ?? []} /></div>}
      </WorkOverviewSection>
      <WorkOverviewSection visible={sections.outputs || focused === 'outputs'} title={t('harness.overview.outputs')} icon="list-check-2" open={choices.outputs ?? false} onOpenChange={open => disclosure(overviewKey, 'outputs', open)}>
      {visibleOperations.map(operation => <div key={operation.id} className="mx-auto max-w-3xl rounded border p-2 text-sm">
        <div>Background operation · {operation.phase} · {operation.outcome ?? 'In progress'} · effect: {operation.effect}</div>
        <InferenceStatus operation={operation} />
        <McpTaskStatus operation={operation} />
        <McpResourceStatus operation={operation} />
        {operation.host_job?.mcpTaskResult && <details><summary>Remote task result</summary><ThreadOutput api={api} identity={identity}
          holder={{ kind: 'operation', operationId: operation.id, output: 'mcp_task_result' }} output={operation.host_job.mcpTaskResult} messageId={`${operation.id}:mcp-task-result`} /></details>}
        {!readOnly && api.processes && operation.executor === 'process_spawn' && operation.call_completion?.kind === 'job_accepted'
          && (operation.intent as { call?: { arguments?: { mode?: string } } } | null)?.call?.arguments?.mode === 'pty'
          && <Button variant="outline" size="sm" disabled={pending} onClick={() => void act(() => openProcessTerminal(operation.id))}>Open process terminal</Button>}
        {operation.external_receipt && <div className="text-xs text-muted-foreground">{operation.external_receipt.executor} · {operation.external_receipt.outcome}</div>}
        {operation.call_completion && operation.call_completion.kind !== 'not_dispatched' && operation.call_completion.content && <details>
          <summary>Call output</summary><ThreadOutput api={api} identity={identity} holder={{ kind: 'operation', operationId: operation.id, output: 'completion' }} output={operation.call_completion.content} messageId={`${operation.id}:completion`} />
        </details>}
        {operation.result?.kind === 'output' && <details><summary>Operation output</summary><ThreadOutput api={api} identity={identity}
          holder={{ kind: 'operation', operationId: operation.id, output: 'result' }} output={operation.result.output} messageId={`${operation.id}:result`} /></details>}
        {operation.external_receipt && <details><summary>External receipt output</summary><ThreadOutput api={api} identity={identity}
          holder={{ kind: 'operation', operationId: operation.id, output: 'external_receipt' }} output={operation.external_receipt.result} messageId={`${operation.id}:external-receipt`} /></details>}
        {!readOnly && canCancelOperation(operation, run?.waiting_on) && <Button variant="ghost" size="sm" onClick={() => void act(() => api.cancelOperation(operation.id), true)}>{operationCancelLabel(operation)}</Button>}
      </div>)}
      {!readOnly && snapshot && <ThreadFollowups key={`${host}:${identity.threadId}:${identity.branchId}`} api={api.followups} family={api.family} mediaRead={api.mediaRead} research={api.research} identity={identity}
        run={run ?? undefined} operations={snapshot.operations} followups={snapshot.followups} pending={pending} act={act}
        cancelObservation={operationId => act(() => api.cancelOperation(operationId))} onContentChange={reportOverviewContent.followups} />}
    {!readOnly && <ThreadRecovery recovery={recovery} disabled={active || actionPending} />}
      </WorkOverviewSection>
      <WorkOverviewSection visible={sections.sources || focused === 'sources'} title={t('harness.overview.sources')} icon="folder" open={choices.sources ?? false} onOpenChange={open => disclosure(overviewKey, 'sources', open)}>
    {!readOnly && !delegated && <ThreadSourcePicker key={identity.branchId} api={api} identity={identity} initialPath={draft.workspacePath ?? initialWorkspacePath}
      onUseChatOnly={() => { useThreadDraftStore.getState().patch(draftKey, { workspacePath: undefined, preparedSource: null, sourceSelection: undefined }); }}
      active={active || pending} launch={snapshot?.launch ?? null} prepared={preparedSource} onPrepared={setPreparedSource} onPreparingChange={setPreparingSource} />}
    {!readOnly && snapshot?.context.checkpoint && <ThreadResources checkpoint={snapshot.context.checkpoint} pending={pending}
      onAddSkill={addSkill}
      onRefresh={() => void act(() => api.resources.refresh({ ...identity, expectedRevision: snapshot.context.checkpoint!.revision }))} />}
      {!readOnly && api.research && <ThreadResearch key={`research:${host}:${identity.threadId}:${identity.branchId}`} api={api.research} materials={api.materials} identity={identity} sourceRunId={run?.id} onContentChange={reportOverviewContent.research} />}
      </WorkOverviewSection>
      <WorkOverviewSection visible={sections.memory || focused === 'memory'} title={t('harness.overview.memory')} icon="book-open" open={choices.memory ?? false} onOpenChange={open => disclosure(overviewKey, 'memory', open)}>
    {snapshot && <ThreadMemory key={identity.threadId} identity={identity} botId={snapshot.thread.bot_id} basis={snapshot.context.checkpoint?.personalization} onContentChange={reportOverviewContent.memory} />}
    {snapshot && hasSummaries && <details className="mx-auto max-h-64 w-full max-w-3xl shrink-0 overflow-y-auto px-4 text-xs text-muted-foreground">
      <summary className="cursor-pointer">Context summaries · checkpoint {snapshot.context.checkpoint?.revision ?? 0} · {snapshot.context.jobs.length} jobs</summary>
      {snapshot.context.checkpoint?.proposal.through_id && <div className="my-2" aria-label="Active context summary">
        <MarkdownRenderer messageId={snapshot.context.checkpoint.id} content={snapshot.context.checkpoint.proposal.summary} />
      </div>}
      {snapshot.context.jobs.map(({ job, run: jobRun }) => {
        const published = snapshot.context.checkpoint?.id === job.request.key;
        const superseded = (snapshot.context.checkpoint?.revision ?? 0) > job.request.expected_revision;
        const terminal = ['completed', 'cancelled', 'failed'].includes(jobRun.state);
        return <div key={jobRun.id} className="my-2 rounded border p-2">
          <Button variant="ghost" size="sm" onClick={() => setContextRunId(jobRun.id)}>{t('chat.context.summaryProcess')}</Button>
          <p>Summary through {job.request.through_id.slice(-8)} · {published ? 'Applied' : jobRun.state}{!published && superseded ? ' · Checkpoint has changed' : ''}</p>
          {!readOnly && jobRun.state === 'completed' && !published && !superseded && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.publishContext(identity, jobRun.id))}>Apply context summary</Button>}
          {!readOnly && !terminal && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.cancelContext(identity, jobRun.id))}>Cancel summary</Button>}
          {!readOnly && !terminal && ['accepted', 'preparing', 'runnable', 'waiting', 'recovering'].includes(jobRun.state) && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.resumeContext(identity, jobRun.id))}>Resume summary preparation</Button>}
        </div>;
      })}
    </details>}
      </WorkOverviewSection>
      <WorkOverviewSection visible={sections.computer} title={t('computer.automation.title')} icon="computer" open={choices.computer ?? false} onOpenChange={open => disclosure(overviewKey, 'computer', open)}>
    {!readOnly && hasComputer && <section className="mx-auto w-full max-w-3xl px-4" aria-label={t('computer.automation.title')}>
      <h3 className="typography-meta">{t('computer.automation.title')}</h3>
      <ComputerAutomationSection view={computer} directory={initialWorkspacePath ?? ''} />
    </section>}
      </WorkOverviewSection>
    </div>
  </WorkOverviewControl>;
  return <ThreadMaterials api={api.materials} identity={identity} onAddRegion={readOnly ? undefined : region => {
    if (pendingAction.current) throw new Error('Wait for the current message before adding a PDF selection.');
    addContentReference(identity, { ref: `document-selection:${crypto.randomUUID()}`, title: region.title, image: region.image,
      source: { kind: 'document', snapshotId: region.snapshotId, sourceHash: region.sourceHash, page: region.page, region: region.region } });
    messageInput.current?.focus();
  }}><ReferenceNavigationContext.Provider value={referenceNavigation}><section ref={handoff.setRoot} className="regular-chat-view relative flex h-full min-h-0 min-w-0 [container-type:inline-size]" aria-label="Thread conversation" data-thread-conversation="true">
    <div className="thread-conversation-layout relative flex min-h-0 min-w-0 flex-1">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {!historyView && run?.state === 'failed' && <div role="alert" aria-label="Run failed" className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-destructive">
      <p>{t('harness.threads.state.failed')}</p>
      {runFailure && <p>{runFailureKey ? t(runFailureKey) : runFailure.message}</p>}
    </div>}
    {!historyView && run?.state === 'cancelled' && <p role="status" aria-label="Run cancelled" className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-muted-foreground">{t('harness.threads.state.cancelled')}</p>}
    {contextRunId && <ContextHistoryDialog key={`${draftKey}:${contextRunId}`} api={api} identity={identity} runId={contextRunId} onClose={() => setContextRunId(undefined)} />}
    {historyOpen && <ChatTreeDialog api={api} identity={identity} open onOpenChange={setHistoryOpen} busy={pending} recoverDisabled={active}
      onFork={entry => { void forkFrom(entry.id); }} onRecover={entry => { showOverview('outputs'); void recovery.recover(entry.id); }} />}
    {!readOnly && snapshot && <ThreadQuestions key={draftKey} operations={snapshot.operations} enabled={operation => !pending && run?.state === 'waiting' && run.waiting_on === operation.waiting_on}
      onCancel={operation => act(() => api.cancelOperation(operation.id))} onAnswer={(operation, answer) => act(() => api.answerQuestion({ ...identity, operationId: operation.id, answer }))} />}
    <div className={cn('relative flex min-h-0 flex-1', empty && 'hidden')}>
    <ConversationSurface owner={String(host)} identity={draftKey} ready={Boolean(snapshot || firstMessage.message)} loadingLabel={t('common.loading')}>
    <ConversationTimeline api={api} identity={identity} snapshot={snapshot} history={visibleHistory}
      liveUser={historyView ? undefined : firstMessage.message} liveUserStatus={firstMessage.status}
      progress={historyView ? [] : progress} streamingTools={historyView ? [] : streamingTools} cwd={emptyWorkspacePath ?? ''} working={!historyView && active && !launch?.preparation_failure && !pause} readOnly={readOnly}
      memory={snapshot?.thread.bot_id ? memorySelection : undefined}
      onQuote={quote => { if (!readOnly && currentViewScope.current === viewScope) { setText(current => [current.trimEnd(), quote].filter(Boolean).join('\n\n')); messageInput.current?.focus(); } }}
      onFork={!readOnly && !pending && onBranchCreated ? id => void forkFrom(id) : undefined}
      onRecover={!readOnly && !pending && !active && snapshot ? id => { showOverview('outputs'); void recovery.recover(id); } : undefined}
      header={<>      <div className="mx-auto flex max-w-3xl items-center gap-2">
        {previousHistory && <Button variant="ghost" size="sm" disabled={historyLoading} onClick={() => void loadEarlier()}>{historyLoading ? 'Loading earlier history' : 'Load earlier history'}</Button>}
        {historyView && <Button variant="outline" size="sm" onClick={returnToLatest}>{historyView.head !== snapshot?.historyPage.head ? 'Show latest messages' : 'Return to latest view'}</Button>}
        {historyView && <span className="text-xs text-muted-foreground">Viewing saved history</span>}
      </div>
</>}
      footer={<>      {snapshot?.operations.filter(operation => operation.id !== pause?.action_id).map(operation => <div key={operation.id} className="mx-auto max-w-3xl">
        <ThreadPermission operation={operation} enabled={!readOnly && !pending && operation.run_id === run?.id && !run?.cancel_requested} onDecide={(permissionId, decision) => act(() => api.decidePermission({ ...identity, operationId: operation.id, permissionId, decision }))} />
      </div>)}
      {!readOnly && snapshot && <ThreadMcpInteractions key={`mcp:${host}:${identity.threadId}:${identity.branchId}`} api={api} identity={identity} eventCursor={snapshot.eventCursor}
        models={models} selectedModel={samplingModel} modelError={modelError} />}
</>} />
    </ConversationSurface>
    {readOnly && error && <p role="alert" className="px-4 text-sm text-destructive">{error}</p>}
    </div>
    {empty && <div className="min-h-6 flex-1" />}
    {!readOnly && <div className="shrink-0 space-y-5 pb-4">
    {empty && <div className="chat-input-column flex flex-col items-center gap-5 pb-1 text-center"><VarinLogo width={24} height={24} decorative className="text-muted-foreground" /><h1 className="text-2xl font-medium tracking-tight text-foreground md:text-3xl">{emptyWorkspacePath ? t('chat.emptyState.draftTitleWithProject', { project: formatDirectoryName(emptyWorkspacePath) }) : t('chat.emptyState.draftTitle')}</h1></div>}
    {snapshot && <ThreadWorkStrips api={api} identity={identity} goals={snapshot.goals} followups={snapshot.followups} pending={pending} act={act} onGoal={() => showOverview('plan')} onFollowups={() => showOverview('outputs')} />}
    <div className="chat-input-column conversation-composer-queue">{snapshot && <ThreadInputQueue key={`${host}:${identity.threadId}:${identity.branchId}`}
      api={api} identity={identity} inputs={snapshot.inputs} pending={pending}
      onSave={async (input, text, images) => {
        let saved = false;
        await act(async () => {
          await (images === undefined ? api.editInput(input.id, input.revision, text) : api.editInput(input.id, input.revision, text, images));
          saved = true;
        });
        return saved;
      }} onCancel={input => act(() => api.cancelInput(input.id, input.revision), true)} />}</div>
    <form className="space-y-2" onSubmit={event => {
      event.preventDefault();
      if (draft.firstSend || draft.identity && !run && (draft.sourceSelection || draft.pdfs?.length)) {
        if (pending || !draft.firstSend && sendDisabled) return;
        const settings = useUIStore.getState();
        const request = draft.firstSend ?? { key: crypto.randomUUID(), status: 'sending' as const, editorText: text, text: projectedText,
          images: requestImages, pdfs: draft.pdfs ?? [], model: { providerId, modelId, thinkingLevel, ...(temperature === undefined ? {} : { temperature }) }, ...(!snapshot?.thread.bot_id && !delegated ? { agent } : {}), workspacePath: draft.workspacePath,
          sourceSelection: draft.sourceSelection, editorContext, inlineContext,
          ...(draft.goalArmed && text.trim() ? { goalObjective: text.trim(), ...(settings.sessionGoalDefaultBudgetEnabled ? { goalBudget: settings.sessionGoalDefaultBudget } : {}) } : {}) };
        handoff.submit(request.key, draftKey, handoff.captureDraft());
        void sendThreadDraft(api, draftKey, request).then(inputId => {
          if (inputId && host === getRuntimeEndpointGeneration()) handoff.accepted(request.key, inputId);
        }, () => { handoff.cancelSubmission(request.key); });
        return;
      }
      if (sendDisabled || fileRead.current) return;
      const generation = identityGeneration.current;
      const sourceRect = handoff.captureDraft();
      void act(async () => {
        const fingerprint = submissionFingerprint();
        if (!pendingInput.current) {
          // A new conversation opened in a workspace starts there. Reopened conversations
          // use their original source; a later sidebar selection is only a navigation hint.
          let sourceForInput = preparedSource;
          if (!active && !delegated && !run && !sourceForInput && draft.workspacePath) {
            const workspace = await api.sources.resolve(identity, { resourceOwner: { kind: 'local' }, path: draft.workspacePath });
            if (generation !== identityGeneration.current || host !== getRuntimeEndpointGeneration()) return;
            sourceForInput = await api.prepareSource({ ...identity, key: crypto.randomUUID(), resourceOwner: workspace.resourceOwner,
              workspaceId: workspace.workspaceId, mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [] });
            if (generation !== identityGeneration.current || host !== getRuntimeEndpointGeneration()) return;
            setPreparedSource(sourceForInput);
          }
          const key = crypto.randomUUID();
          const attachments = materials.length ? { materials: materials.map(({ snapshotId }) => ({ snapshotId })) } : {};
          const submit = { ...identity, key, text: projectedText, images: requestImages, ...attachments, expectedHead: branch?.head ?? null, model: { providerId, modelId, thinkingLevel, ...(temperature === undefined ? {} : { temperature }) }, ...(!snapshot?.thread.bot_id && !delegated ? { agent } : {}), ...(sourceForInput ? { source: sourceForInput.source } : {}) };
          const queued = { ...identity, key, text: projectedText, images: requestImages, ...attachments, mode: inputMode };
          const continuation = { ...identity, key, text: projectedText, images: requestImages, ...attachments, previousRunId: run?.id ?? '', expectedHead: branch?.head ?? null };
          if (!active && delegated && (!api.collaboration || !run)) throw new Error('Child continuation is unavailable');
          const goalSettings = useUIStore.getState();
          const goal = draft.goalArmed && !active && !delegated && text.trim() ? { goalObjective: text.trim(),
            ...(goalSettings.sessionGoalDefaultBudgetEnabled ? { goalBudget: goalSettings.sessionGoalDefaultBudget } : {}) } : {};
          pendingInput.current = { fingerprint, editorText: text, editorContext, inlineContext, preparedSource: sourceForInput, ...goal, status: 'sending', ...(active ? { kind: 'enqueue' as const, input: queued }
            : delegated ? { kind: 'continue' as const, input: continuation } : { kind: 'submit' as const, input: submit }) };
        }
        const original = pendingInput.current;
        const acceptedInputId = await deliverThreadInput(api, original, next => {
          useThreadDraftStore.getState().patch(draftKey, current => current.pendingInput?.input.key === original.input.key ? { pendingInput: next } : {});
        });
        acknowledgeEditorContextAttachments(original.editorContext ?? [], draftKey);
        for (const bucket of original.inlineContext ?? []) useInlineCommentDraftStore.getState().acknowledgeDrafts(bucket.key, bucket.drafts);
        // A real receipt clears only the original captured editor bytes, even if its view unmounted.
        useThreadDraftStore.getState().patch(draftKey, current => current.pendingInput?.input.key === original.input.key ? {
          pendingInput: undefined, preparedSource: current.preparedSource === original.preparedSource ? null : current.preparedSource,
          ...(original.goalObjective ? { goalArmed: false } : {}),
          text: current.text === original.editorText ? '' : current.text,
          images: current.images.filter(image => !(original.input.images ?? []).includes(image)),
          materials: current.materials.filter(material => !(original.input.materials ?? []).some(item => item.snapshotId === material.snapshotId)),
        } : {});
        if (generation !== identityGeneration.current || host !== getRuntimeEndpointGeneration()) return;
        returnToLatest();
        if (acceptedInputId && original.kind !== 'enqueue') {
          useTimelineViewStore.getState().anchor(draftKey, acceptedInputId);
          handoff.submit(original.input.key, draftKey, sourceRect);
          handoff.accepted(original.input.key, acceptedInputId);
        }
      });
    }}>
      {delegated && !active && preparingDelegation && <p role="status" className="text-sm text-muted-foreground">{preparingDelegation
        ? 'A delegated execution is preparing. Its original input remains accepted.'
        : 'Continue in a new Run using this child’s exact previous configuration and source selection. Previous reports and file results remain separate.'}</p>}
      {sourceCannotBeApplied && <p role="status" className="text-sm text-muted-foreground">The prepared workspace needs a new run. Keep the current workspace to queue this message, or wait for this run to finish.</p>}
      {pause && <p role="status" aria-label="Policy pause" className="text-sm text-muted-foreground">Paused: {pause.reason || 'Waiting for your explicit resume.'} Messages can be queued while paused.</p>}
      {policy?.preparation && <p role="status" aria-label="Strategy preparation" className="text-sm text-muted-foreground">{policy.preparation.status === 'preparing' ? 'The Host is preparing a strategy candidate.' : `The Host could not prepare the strategy candidate: ${policy.preparation.code ?? 'preparation failed'}`}</p>}
      {policyUpdatePending && <p role="status" aria-label="Policy update" className="text-sm text-muted-foreground">{policyUpdate?.status === 'preparing' ? 'Preparing the selected strategy. The current strategy remains active.' : 'Strategy prepared for the next closed decision boundary.'}{pause ? ' This run remains paused until you resume it.' : ''}</p>}
      {policyUpdate?.status === 'failed' && <p role="status" aria-label="Policy update failed" className="text-sm text-muted-foreground">{policyIncompatible ? 'The selected strategy cannot preserve this private checkpoint. The current strategy remains active. Restarting strategy state keeps conversation history and independent tasks.' : `Strategy update was not applied: ${policyUpdate.failure ?? 'preparation failed'}`}</p>}
      {snapshot?.launch?.preparation_failure && <p role="alert" className="text-sm text-destructive">{t('chat.run.preparationFailed', { reason: threadSourceFailureMessage(snapshot.launch.preparation_failure) ?? snapshot.launch.preparation_failure })}</p>}
      {draft.pendingInput?.status === 'unknown' && <p role="status" className="text-sm text-muted-foreground">{draft.pendingInput.kind === 'submit' && draft.pendingInput.acceptedRunId ? t('chat.send.goalPending') : t('chat.send.unconfirmed')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {draft.firstSend?.error && <p role="alert" className="text-sm text-destructive">{draft.firstSend.error}</p>}
      {draft.sendError && <p role="alert" className="text-sm text-destructive">{draft.sendError}</p>}
      {modelError && <p role="alert" className="text-sm text-destructive">{modelError}</p>}
      {snapshot?.modelSelection.desired?.status === 'failed' && <p role="alert" className="text-sm text-destructive">{t('chat.model.preparationFailed', { reason: snapshot.modelSelection.desired.failure ?? '' })}</p>}
      {snapshot?.modelSelection.desired && snapshot.modelSelection.desired.id !== snapshot.modelSelection.active?.id && snapshot.modelSelection.desired.status !== 'failed' && <p role="status" className="text-sm text-muted-foreground">{t('chat.model.nextRequest')}</p>}
      {images.length > 0 && acceptsImages === false && <p role="alert" className="text-sm text-destructive">{t('chat.model.imagesUnsupported')}</p>}
      <input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label="Choose image attachments"
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
      <input ref={pdfInput} type="file" accept="application/pdf,.pdf" multiple hidden aria-label={t('chat.fileAttachment.actions.choosePdfs')}
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
      <AutoReviewBanner identity={identity} />
      {draft.goalArmed && <p className="px-2 typography-meta text-primary">{t('thread.composer.goalArmed')}</p>}
      <ThreadComposer onOpenHistory={() => setHistoryOpen(true)} identityKey={draftKey} placement={empty ? 'center' : 'bottom'}
        agentControls={!snapshot?.thread.bot_id && !delegated ? <ThreadAgentControls workFocus={workFocus} pending={active} disabled={pending || Boolean(draft.firstSend || draft.pendingInput)}
          onWorkFocusChange={workFocus => useThreadDraftStore.getState().patch(draftKey, { workFocus })} /> : undefined}
        messageHistory={visibleHistory.filter(item => item.source === 'user').slice().reverse().map(item => typeof item.content === 'string' ? item.content : typeof (item.content as { text?: unknown })?.text === 'string' ? (item.content as { text: string }).text : '')}
        onCompact={branch?.head && !active && providerId && modelId ? () => { showOverview('memory'); void compactThrough(branch.head!); } : undefined}
        editorRef={messageInput} value={text} onChange={setText} models={models}
        providerId={providerId} modelId={modelId} thinkingLevel={thinkingLevel} onModelChange={selectModel}
        modelDisabled={pending || Boolean(draft.firstSend) || (delegated && !active)} attachmentDisabled={pending || Boolean(draft.firstSend || draft.pendingInput) || readingFiles}
        imageDisabled={acceptsImages === false} sendDisabled={draft.firstSend ? pending : sendDisabled} pending={pending} active={active} retrying={Boolean(draft.firstSend || draft.pendingInput)}
        delivery={inputMode} onDeliveryChange={setInputMode} allowNextRun={!delegated}
        onFiles={files => void addFiles(files)} onAttachImages={() => fileInput.current?.click()} onAttachPdfs={() => pdfInput.current?.click()}
        goalArmed={draft.goalArmed} onGoal={() => {
          if (active || delegated || snapshot?.goals.some(goal => goal.control !== 'complete' && goal.control !== 'cancelled')) showOverview('plan');
          else if (!draft.pendingInput) useThreadDraftStore.getState().patch(draftKey, { goalArmed: !draft.goalArmed });
        }} onStop={active && branch?.active_run_id ? () => void act(() => api.cancelRun(branch.active_run_id!), true) : undefined}
        attachmentNames={[...images.map(() => ''), ...materials.map(material => material.filename)]}
        hasInput={Boolean(text.trim() || images.length || materials.length || inlineDrafts.length || editorContext.length)}
        onWorkspace={() => showOverview('sources')} workspaceLabel={preparedSource ? formatDirectoryName(preparedSource.path) : launch?.selection.source?.live_root ? formatDirectoryName(launch.selection.source.live_root.canonicalRoot) : launch?.selection.source ? t('harness.overview.sources') : draft.workspacePath ? formatDirectoryName(draft.workspacePath) : t('thread.composer.chatOnly')}
        workspacePath={preparedSource?.source.resourceOwner.kind === 'local' ? preparedSource.path
          : launch?.selection.source?.resource_owner.kind === 'local' && launch.selection.source.mode === 'live_root' ? launch.selection.source.live_root?.canonicalRoot
          : !launch?.selection.source ? draft.workspacePath : undefined}
        skills={snapshot?.context.checkpoint?.resources?.snapshot.skills.map(skill => skill.name) ?? []}>
        <div className="space-y-2 px-3 empty:hidden">{emptyWorkspacePath && <ActiveEditorSuggestion threadKey={draftKey} />}      <EditorContextAttachmentChips threadKey={draftKey} />
      {inlineContext.length > 0 && <div className="flex flex-wrap gap-1" aria-label="Attached context">
        {inlineContext.flatMap(bucket => bucket.drafts.map(item => <Button key={item.id} type="button" size="sm" variant="outline"
          title={item.text || item.fileLabel} onClick={() => useInlineCommentDraftStore.getState().acknowledgeDrafts(bucket.key, [item])}>
          {item.fileLabel} · {item.startLine}–{item.endLine} ×
        </Button>))}
      </div>}
      <ImageAttachmentStrip images={images} removeLabel={t('chat.fileAttachment.actions.removeImage')}
        onRemove={index => setImages(current => current.filter((_, candidate) => candidate !== index))} />
      <ThreadMaterialAttachments materials={materials} locked={pending || Boolean(draft.firstSend || draft.pendingInput)}
        onRemove={snapshotId => { if (!pendingAction.current && !pendingInput.current) setMaterials(current => current.filter(material => material.snapshotId !== snapshotId)); }} />
      {draft.pdfs?.map(pdf => <span key={pdf.id} className="inline-flex rounded border px-2 py-1 text-sm">{pdf.filename}</span>)}
      {readingFiles && <p role="status">{t('chat.fileAttachment.uploading')}</p>}
        </div>
      </ThreadComposer>
      <div className="chat-input-column flex gap-2">
        {run && pause && <Button type="button" variant="outline" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.resume(run.id, pause.wait_id))}>{t('chat.run.resume')}</Button>}
        {active && run && policyUpdate && policyIncompatible && <Button type="button" variant="outline" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.restartPolicy(identity, run.id, policyUpdate.selection_id))}>Restart strategy state</Button>}
        {active && run && policyUpdate && policyUpdatePending && <Button type="button" variant="ghost" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.cancelPolicyUpdate(identity, run.id, policyUpdate.selection_id))}>Cancel strategy update</Button>}
        {run && launch?.startable && launch.requires_rebind && launch.preparation_failure && !pause && <Button type="button" variant="ghost" disabled={pending} onClick={() => void act(() => api.retryPreparation(run.id))}>{t('chat.run.retryPreparation')}</Button>}
      </div>
    </form>
    {empty && <div className="conversation-starters"><DraftPresetChips cwd={draft.workspacePath ?? initialWorkspacePath} sessionId={identity.threadId} className="oc-draft-starters"
      onSubmit={starter => {
        if (starter.ref.type === 'command' && starter.ref.name === 'craft-goal') { useThreadDraftStore.getState().patch(draftKey, { goalArmed: true }); messageInput.current?.focus(); return; }
        if (starter.ref.type === 'command' && starter.ref.name === 'schedule-task') { useUIStore.getState().setScheduledTasksDialogOpen(true); return; }
        setText(current => [current.trimEnd(), starter.submitText].filter(Boolean).join('\n\n'));
        messageInput.current?.focus();
      }} /></div>}
    </div>}
    {empty && <div className="min-h-6 flex-1" />}
    </div>
    {overview}
    </div>
  </section></ReferenceNavigationContext.Provider></ThreadMaterials>;
}
