import { deliverThreadInput } from '@/lib/agent-runtime/threadInputDelivery';
import { AutoReviewBanner } from '@/components/chat/AutoReviewBanner';
import { ReviewTransferActions } from './ReviewTransferActions';
import { EditorContextAttachmentChips } from '@/components/workbench/EditorContextAttachmentChips';
import { acknowledgeEditorContextAttachments, getEditorContextAttachmentsRevision, listEditorContextAttachments, subscribeEditorContextAttachments } from '@/lib/agent-editor/attachments';
import { projectEditorContextAttachments } from '@/lib/agent-editor/projection';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { useThreadStore, threadHostKey, threadIdentityKey } from '@/stores/useThreadStore';
import { useThreadDraftStore, EMPTY_THREAD_DRAFT, type ThreadPendingInput, type ThreadMaterialAttachment } from '@/stores/useThreadDraftStore';
import { ThreadMaterials } from './ThreadMaterials';
import { ThreadMaterialAttachments } from './ThreadMaterialAttachments';
import { buildPdfMaterialCitationMarkdown } from '@/lib/materials/pdfMaterialCitation';
import { ComputerAutomationSection } from '@/components/thread/ComputerAutomationSection';
import { useComputerAutomation } from '@/stores/useComputerAutomation';
import { ChildExecutions, ThreadExecutions } from './ThreadExecutions';
import { ThreadMessages } from './ThreadMessages';
import { ThreadFamily } from './ThreadFamily';
import { attachProcessTerminal } from '@/lib/attachProcessTerminal';
import { ThreadChildProfiles } from './ThreadChildProfiles';
import { ThreadPlan } from './ThreadPlan';
import { ThreadGoal } from './ThreadGoal';
import { ThreadFollowups } from './ThreadFollowups';
import { ThreadResearch } from './ThreadResearch';
import { ThreadMemory } from './ThreadMemory';
import { ThreadMemorySelection } from './ThreadMemorySelection';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { ThreadResources } from './ThreadResources';
import { ThreadSkillMaterials } from './ThreadSkillMaterials';
import { ThreadPermission } from './ThreadPermission';
import { ThreadQuestion } from './ThreadQuestion';
import { ThreadMcpInteractions } from './ThreadMcpInteraction';
import { ThreadSourcePicker } from './ThreadSourcePicker';
import { useThreadRecovery } from './useThreadRecovery';
import { ThreadRecovery } from './ThreadRecovery';
import type { ImageAttachment, InferenceBinding, InferenceReceipt } from '@varin/protocol';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { fileToImageAttachment } from '@/components/chat/composer/imageAttachments';
import { fileToBase64 } from '@/components/chat/composer/fileAttachments';
import { useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import React from 'react';
import { createModelConnectionsHttpAPI, threadMemorySourceText, threadSourceFailureMessage, ThreadRequestError, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadModel, ThreadModelInfo, ThreadThinkingLevel, ThreadSnapshot, ThreadsAPI, ThreadHistoryPage, ThreadPreparedSource } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { ThreadComposer } from './ThreadComposer';
import { DraftPresetChips } from '@/components/chat/DraftPresetChips';
import { useUIStore } from '@/stores/useUIStore';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { WorkOverviewControl, type OverviewPeekRow } from './WorkOverviewControl';
import { WorkOverviewSection } from './WorkOverviewSection';
import { EMPTY_WORK_OVERVIEW_CHOICES, useWorkOverviewStore } from '@/stores/useWorkOverviewStore';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { Icon } from '@/components/icon/Icon';
import { cn, formatDirectoryName } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ThreadProjection } from '@/lib/agent-runtime/thread-projection';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { projectTimeline } from '@/lib/agent-runtime/thread-timeline';
import { ThreadMessage } from './ThreadMessage';
import { ThreadNavigator } from './ThreadNavigator';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui';
import { ThreadOutput } from './ThreadMedia';
import { ThreadQueuedInput } from './ThreadQueuedInput';
import { ThreadChildReport } from './ThreadChildReport';

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

export function ThreadConversation({ api, identity, onBranchCreated, initialWorkspacePath, preferredModel, onWorkChanged, readOnly = false }: { onWorkChanged?: () => void; preferredModel?: ThreadModel | null; readOnly?: boolean; api: ThreadsAPI; identity: ThreadIdentity; onBranchCreated?: (identity: ThreadIdentity) => void; initialWorkspacePath?: string }) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const draftKey = threadIdentityKey(threadHostKey(), identity);
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
  const projectedText = projectEditorContextAttachments(appendInlineComments(text, inlineDrafts), editorContext);
  const providerId = draft.model?.providerId ?? '';
  const modelId = draft.model?.modelId ?? '';
  const thinkingLevel = draft.model?.thinkingLevel ?? 'off';
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
  const [progress, setProgress] = React.useState('');
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
  const [actionPending, setPending] = React.useState(false);
  const pendingAction = React.useRef<object | null>(null);
  const projection = React.useRef<ThreadProjection | undefined>(undefined);
  React.useEffect(() => {
    identityGeneration.current += 1; forkKeys.current.clear(); compactionKeys.current.clear();
    historyGeneration.current += 1; setHistoryView(null); setHistoryLoading(false);
    setPreparingSource(false);
    pendingAction.current = null; setPending(false); setError(undefined);
    setSnapshot(undefined); setProgress(''); setReadingFiles(false); fileReadGeneration.current += 1;
    fileRead.current?.abort(); fileRead.current = null;
    const view = new ThreadProjection(api, identity, value => { snapshotHost.current = host; setSnapshot(value); if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') void useThreadStore.getState().markRead(identity.threadId, value.thread.activity_cursor).catch(() => {}); }, value => setError(value instanceof Error ? value.message : 'Thread unavailable'), setProgress);
    projection.current = view; view.start();
    return () => { identityGeneration.current += 1; historyGeneration.current += 1; fileReadGeneration.current += 1; fileRead.current?.abort(); fileRead.current = null; view.close(); };
  }, [api, identity, host]);
  const snapshot = snapshotHost.current === host && snapshotState?.identity.threadId === identity.threadId && snapshotState?.identity.branchId === identity.branchId ? snapshotState : undefined;
  const workRevision = snapshot ? JSON.stringify([snapshot.activeRun?.id, snapshot.activeRun?.state,
    snapshot.children?.map(child => [child.child_thread_id, child.state])]) : null;
  React.useEffect(() => { if (workRevision) onWorkChanged?.(); }, [workRevision, onWorkChanged]);
  const branch = snapshot?.thread.branches.find(value => value.branch_id === identity.branchId);
  const run = snapshot?.activeRun ?? branch?.latest_run;
  const samplingConfiguration = (snapshot?.modelSelection.active?.configuration ?? run?.configuration) as
    { providerId?: string; model?: string; thinkingLevel?: ThreadThinkingLevel; modelOptions?: { temperature?: number; catalogModelId?: string } } | undefined;
  const samplingModel: ThreadModel | undefined = samplingConfiguration?.providerId && samplingConfiguration.model ? {
    providerId: samplingConfiguration.providerId, modelId: samplingConfiguration.modelOptions?.catalogModelId ?? samplingConfiguration.model,
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
  const pause = run?.state === 'waiting' && launch?.pause?.wait_id === run.waiting_on ? launch.pause : null;
  const policy = snapshot?.policySelection;
  const policyUpdate = policy?.desired && policy.desired.run_id === run?.id ? policy.desired : null;
  const policyUpdatePending = policyUpdate?.status === 'preparing' || policyUpdate?.status === 'ready';
  const policyIncompatible = policyUpdate?.status === 'failed' && policyUpdate.failure === 'policy_state_incompatible';
  const acceptsImages = active || delegated ? (run?.configuration as { acceptsImages?: boolean } | undefined)?.acceptsImages
    : models.find(model => model.providerId === providerId && model.modelId === modelId)?.acceptsImages;
  React.useEffect(() => {
    const config = (snapshot?.modelSelection.desired?.configuration ?? run?.configuration) as { providerId?: string; model?: string; thinkingLevel?: ThreadThinkingLevel; modelOptions?: { catalogModelId?: string } } | undefined;
    if (config?.providerId && config.model && (active || !providerId && preferredModel === undefined)) { setProviderId(config.providerId); setModelId(config.modelOptions?.catalogModelId ?? config.model); setThinkingLevel(config.thinkingLevel ?? 'off'); }
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
          ...(typeof thinking === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking) ? { thinkingLevel: thinking as ThreadThinkingLevel } : {}) } };
      });
    }).catch(failure => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [needsDefaultModel, host, draftKey, draft.workspacePath, initialWorkspacePath, defaultsVersion]);
  const act = async (work: () => Promise<unknown>, interrupt = false) => {
    if (readOnly || pendingAction.current && !interrupt) return;
    const action = {}; pendingAction.current = action;
    const generation = identityGeneration.current;
    const current = () => generation === identityGeneration.current && host === getRuntimeEndpointGeneration() && pendingAction.current === action;
    setPending(true); setError(undefined);
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
    if (!files.length || readOnly || fileRead.current || pendingAction.current || pendingInput.current) return;
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
  const pending = actionPending || recovery.blocked;
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
  const previousHistory = historyView ? historyView.previous : snapshot?.historyPage.previous;
  const memorySelection = getRegisteredRuntimeAPIs()?.bots?.selection;
  const memoryHead = historyView?.head ?? snapshot?.historyPage.head;
  const submissionFingerprint = () => JSON.stringify([identity.threadId, identity.branchId, projectedText, images, materials, providerId, modelId, thinkingLevel, inputMode, preparedSource?.source]);
  const sourceCannotBeApplied = active && Boolean(preparedSource) && !pendingInput.current;
  const sendDisabled = pending || (!draft.pendingInput && (preparingDelegation || preparingSource || sourceCannotBeApplied || readingFiles
    || (images.length > 0 && acceptsImages === false)
    || (!text.trim() && !images.length && !materials.length && !inlineDrafts.length && !editorContext.length)
    || (!active && (delegated ? !api.collaboration || !run : !providerId || !modelId))));
  const overviewKey = draftKey;
  const choices = useWorkOverviewStore(state => state.bySession[overviewKey] ?? EMPTY_WORK_OVERVIEW_CHOICES);
  const disclosure = useWorkOverviewStore(state => state.setDisclosure);
  const showOverview = (section: Parameters<typeof disclosure>[1]) => { disclosure(overviewKey, 'overview', true); disclosure(overviewKey, section, true); };
  const overviewRows: OverviewPeekRow[] = [];
  if (snapshot?.goals.length) overviewRows.push({ id: 'goals', section: 'plan', icon: 'target', label: t('chat.draftPresets.craftGoal.label'), value: snapshot.goals.length });
  if (snapshot?.children?.length) overviewRows.push({ id: 'children', section: 'threads', icon: 'git-branch', label: t('harness.overview.threads'), value: snapshot.children!.length });
  if (snapshot?.operations.some(operation => operation.phase !== 'terminal')) overviewRows.push({ id: 'operations', section: 'outputs', icon: 'loader-4', label: t('harness.overview.outputs'), value: snapshot.operations.filter(operation => operation.phase !== 'terminal').length });
  if (hasComputer) overviewRows.push({ id: 'computer', section: 'computer', icon: 'computer', label: t('computer.automation.title') });
  const empty = Boolean(snapshot && !visibleHistory.length && !progress && !active);
  const emptyWorkspacePath = preparedSource?.path ?? draft.workspacePath;
  const scrollArea = React.useRef<HTMLDivElement>(null);
  const stickToBottom = React.useRef(true);
  React.useLayoutEffect(() => {
    if (stickToBottom.current && !historyView) scrollArea.current?.scrollTo?.({ top: scrollArea.current.scrollHeight });
  }, [visibleHistory.length, progress, historyView]);
  const overview = <WorkOverviewControl open={choices.overview ?? false} compactOpen={choices.compact ?? false}
    attention={Boolean(run?.waiting_on || recovery.unavailable || error)} rows={overviewRows}
    onOpenChange={open => disclosure(overviewKey, 'overview', open)} onCompactChange={open => disclosure(overviewKey, 'compact', open)}
    onSelect={section => showOverview(section)}>
    <div className="border-b border-border/50 px-4 py-3 typography-ui-label font-medium">{t('harness.overview.title')}</div>
    <div className="thread-work-overview min-h-0 overflow-y-auto">
      <WorkOverviewSection title={t('harness.overview.plan')} icon="task" open={choices.plan ?? false} onOpenChange={open => disclosure(overviewKey, 'plan', open)}>
      {!readOnly && snapshot && <ThreadGoal api={api.goals} identity={identity} goals={snapshot.goals} sourceRunId={run?.id} refresh={async () => { await projection.current?.refresh(); }} />}
      {!readOnly && api.plan && <ThreadPlan api={api.plan} identity={identity} contextRevision={snapshot?.context.checkpoint?.revision} />}
      </WorkOverviewSection>
      <WorkOverviewSection title={t('harness.overview.threads')} icon="git-branch" open={choices.threads ?? false} onOpenChange={open => disclosure(overviewKey, 'threads', open)}>
      {launch && <ThreadChildProfiles launch={launch.selection} />}
      {api.family && <ThreadFamily api={api.family} mediaRead={api.mediaRead} identity={identity} />}
      {!readOnly && api.messages && <ThreadMessages api={api.messages} family={api.family} identity={identity} eventCursor={snapshot?.eventCursor} cancelObservation={pending ? undefined : operationId => act(() => api.cancelOperation(operationId), true)} />}
      {snapshot?.children?.map(child => <div key={child.operation_id} className="mx-auto max-w-3xl rounded border p-3 text-sm" aria-label="Child task">
        <div>{child.selected_profile.preset_id ?? 'Normal child'}{child.source.kind !== 'absent' && ` · ${child.selected_profile.work_mode === 'read_only' ? 'Read-only source' : 'Private working copy'}`} · {child.state}</div>
        <div className="text-xs text-muted-foreground">{child.source.kind === 'absent' ? 'No file source' : child.source.kind === 'pending' ? 'Preparing a stable source' : `Source ready · ${child.source.provenance.consistency}`}</div>
        {child.source.kind === 'ready' && child.source.provenance.consistency !== 'fixed-root' && <div className="text-xs text-muted-foreground">{child.source.provenance.contentMode === 'saved-files' ? 'Saved files' : 'Fixed draft baseline'}{child.source.provenance.omittedDraftPaths.length > 0 ? ` · ${child.source.provenance.omittedDraftPaths.length} unsaved overlays omitted` : ''}</div>}
        <div className="text-xs text-muted-foreground">{child.code_result.kind === 'published'
          ? `File result fixed · revision ${child.code_result.result.result_revision} · effect: ${child.code_result.effect} · parent integration requires a separate action`
          : child.code_result.kind === 'not_applicable' ? 'File result not applicable'
          : child.code_result.kind === 'no_changes' ? 'No file changes'
          : child.code_result.kind === 'unavailable' ? `File result unavailable · ${child.code_result.code} · effect: ${child.code_result.effect}`
          : child.code_result.kind === 'candidate' ? 'File result fixed; publication pending'
          : child.code_result.kind === 'settling' ? 'Waiting for child writers and original receipts before fixing the file result'
          : child.report ? 'Report complete; file result waiting for writers and original receipts' : 'File result pending'}</div>
        <div className="text-xs text-muted-foreground">{child.launch.model} · {child.selected_profile.tools.join(', ') || 'No tools'}</div>
        <div className="text-xs text-muted-foreground">{child.child_thread_id}</div>
        <p>{child.input.task}</p>
        {child.report && <><div className="text-xs text-muted-foreground">Report · {child.report.outcome}</div><MarkdownRenderer messageId={`child:${child.operation_id}`} content={child.report.detail ?? "Report stored in child history."} /></>}
        {child.report?.history_ids.map(itemId => <ThreadChildReport key={itemId} api={api} identity={identity} operationId={child.operation_id} itemId={itemId} />)}
        <ChildExecutions key={`${host}:${identity.threadId}:${identity.branchId}:${child.operation_id}`} api={api} identity={identity} operationId={child.operation_id} />
        {!readOnly && api.collaboration && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.collaboration!.cancelChild(identity, child.operation_id))}>Stop child subtree</Button>}
      </div>)}
      {!readOnly && api.collaboration && <Button variant="outline" size="sm" disabled={pending} onClick={() => void act(() => api.collaboration!.cancelTree(identity))}>Stop task and children</Button>}
    {delegated && <div className="mx-auto w-full max-w-3xl px-4"><ThreadExecutions key={`${host}:${identity.threadId}:${identity.branchId}`} api={api} identity={identity} executions={snapshot?.delegatedExecutions ?? []} /></div>}
      </WorkOverviewSection>
      <WorkOverviewSection title={t('harness.overview.outputs')} icon="list-check-2" open={choices.outputs ?? false} onOpenChange={open => disclosure(overviewKey, 'outputs', open)}>
      {snapshot?.operations.filter(operation => operation.id !== pause?.action_id).map(operation => <div key={operation.id} className="mx-auto max-w-3xl rounded border p-2 text-sm">
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
        cancelObservation={operationId => act(() => api.cancelOperation(operationId))} />}
    {!readOnly && <ThreadRecovery recovery={recovery} disabled={active || actionPending} />}
      </WorkOverviewSection>
      <WorkOverviewSection title={t('harness.overview.sources')} icon="folder" open={choices.sources ?? false} onOpenChange={open => disclosure(overviewKey, 'sources', open)}>
    {!readOnly && !delegated && <ThreadSourcePicker key={identity.branchId} api={api} identity={identity} initialPath={draft.workspacePath ?? initialWorkspacePath}
      onUseChatOnly={() => { useThreadDraftStore.getState().patch(draftKey, { workspacePath: undefined, preparedSource: null }); }}
      active={active || pending} launch={snapshot?.launch ?? null} prepared={preparedSource} onPrepared={setPreparedSource} onPreparingChange={setPreparingSource} />}
    {!readOnly && snapshot?.context.checkpoint && <ThreadResources checkpoint={snapshot.context.checkpoint} pending={pending}
      onAddSkill={addSkill}
      onRefresh={() => void act(() => api.resources.refresh({ ...identity, expectedRevision: snapshot.context.checkpoint!.revision }))} />}
      {!readOnly && api.research && <ThreadResearch key={`research:${host}:${identity.threadId}:${identity.branchId}`} api={api.research} materials={api.materials} identity={identity} sourceRunId={run?.id} />}
      </WorkOverviewSection>
      <WorkOverviewSection title={t('harness.overview.memory')} icon="book-open" open={choices.memory ?? false} onOpenChange={open => disclosure(overviewKey, 'memory', open)}>
    {snapshot && <ThreadMemory key={identity.threadId} identity={identity} botId={snapshot.thread.bot_id} basis={snapshot.context.checkpoint?.personalization} />}
    {snapshot && <details className="mx-auto max-h-64 w-full max-w-3xl shrink-0 overflow-y-auto px-4 text-xs text-muted-foreground">
      <summary className="cursor-pointer">Context summaries · checkpoint {snapshot.context.checkpoint?.revision ?? 0} · {snapshot.context.jobs.length} jobs</summary>
      {snapshot.context.checkpoint?.proposal.through_id && <div className="my-2" aria-label="Active context summary">
        <MarkdownRenderer messageId={snapshot.context.checkpoint.id} content={snapshot.context.checkpoint.proposal.summary} />
      </div>}
      {snapshot.context.jobs.map(({ job, run: jobRun }) => {
        const published = snapshot.context.checkpoint?.id === job.request.key;
        const superseded = (snapshot.context.checkpoint?.revision ?? 0) > job.request.expected_revision;
        const terminal = ['completed', 'cancelled', 'failed'].includes(jobRun.state);
        return <div key={jobRun.id} className="my-2 rounded border p-2">
          <p>Summary through {job.request.through_id.slice(-8)} · {published ? 'Applied' : jobRun.state}{!published && superseded ? ' · Checkpoint has changed' : ''}</p>
          {!readOnly && jobRun.state === 'completed' && !published && !superseded && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.publishContext(identity, jobRun.id))}>Apply context summary</Button>}
          {!readOnly && !terminal && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.cancelContext(identity, jobRun.id))}>Cancel summary</Button>}
          {!readOnly && !terminal && ['accepted', 'preparing', 'runnable', 'waiting', 'recovering'].includes(jobRun.state) && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.resumeContext(identity, jobRun.id))}>Resume summary preparation</Button>}
        </div>;
      })}
    </details>}
      </WorkOverviewSection>
      <WorkOverviewSection title={t('computer.automation.title')} icon="computer" open={choices.computer ?? false} onOpenChange={open => disclosure(overviewKey, 'computer', open)}>
    {!readOnly && hasComputer && <section className="mx-auto w-full max-w-3xl px-4" aria-label={t('computer.automation.title')}>
      <h3 className="typography-meta">{t('computer.automation.title')}</h3>
      <ComputerAutomationSection view={computer} directory={initialWorkspacePath ?? ''} />
    </section>}
      </WorkOverviewSection>
    </div>
  </WorkOverviewControl>;
  return <ThreadMaterials api={api.materials} identity={identity} onAddRegion={readOnly || acceptsImages === false ? undefined : region => {
    if (pendingAction.current) throw new Error('Wait for the current message before adding a PDF selection.');
    setText(current => [current.trimEnd(), buildPdfMaterialCitationMarkdown(region.title, region)].filter(Boolean).join('\n\n'));
    setImages(current => [...current, region.image]);
    messageInput.current?.focus();
  }}><section className="regular-chat-view relative flex h-full min-h-0 flex-col [container-type:inline-size]" aria-label="Thread conversation" data-thread-conversation="true">
    {overview}
    <div className={cn('relative flex min-h-0 flex-1', empty && 'hidden')}>
    {!empty && <ThreadNavigator items={visibleHistory} scrollArea={scrollArea} />}
    <div ref={scrollArea} className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4"
      onScroll={event => { const el = event.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        {previousHistory && <Button variant="ghost" size="sm" disabled={historyLoading} onClick={() => void loadEarlier()}>{historyLoading ? 'Loading earlier history' : 'Load earlier history'}</Button>}
        {historyView && <Button variant="outline" size="sm" onClick={returnToLatest}>{historyView.head !== snapshot?.historyPage.head ? 'Show latest messages' : 'Return to latest view'}</Button>}
        {historyView && <span className="text-xs text-muted-foreground">Viewing saved history</span>}
      </div>
      {projectTimeline(visibleHistory).map(({ item, result }) => <ThreadMessage key={item.id} api={api} identity={identity} item={item} result={result} running={active && item.run_id === run?.id}
        onQuote={readOnly ? undefined : quote => { setText(current => [current.trimEnd(), quote.split('\n').map(line => `> ${line}`).join('\n'), ''].filter((part, index) => part || index === 2).join('\n\n')); messageInput.current?.focus(); }}
        onFork={!readOnly && !pending && onBranchCreated ? () => void forkFrom(item.id) : undefined}
        onRecover={!readOnly && !pending && !active && snapshot ? () => { showOverview('outputs'); void recovery.recover(item.id); } : undefined}>
        <ThreadSkillMaterials content={item.content} />
        {!readOnly && <ReviewTransferActions identity={identity} item={item} />}
        <div className="flex items-center gap-1 text-muted-foreground opacity-60 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
          <button type="button" className="rounded-md p-1.5 hover:bg-interactive-hover" title={t('chat.messageBody.actions.copyMessage')} aria-label={t('chat.messageBody.actions.copyMessage')} onClick={() => {
            const text = historyParts(item.content, item.source).flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n\n');
            void copyTextToClipboard(text).then(result => { if (!result.ok) toast.error(result.error); });
          }}><Icon name="file-copy" className="size-3.5" /></button>
          {!readOnly && (item.source === 'user' || item.source === 'assistant') && <button type="button" className="rounded-md p-1.5 hover:bg-interactive-hover disabled:opacity-40"
            disabled={pending || active || !snapshot} title={t('chat.messageBody.actions.revertAria')} aria-label={t('chat.messageBody.actions.revertAria')} onClick={() => { showOverview('outputs'); void recovery.recover(item.id); }}><Icon name="history" className="size-3.5" /></button>}
          {!readOnly && onBranchCreated && <button type="button" className="rounded-md p-1.5 hover:bg-interactive-hover disabled:opacity-40" disabled={pending}
            title={t('chat.messageBody.actions.forkAria')} aria-label={t('chat.messageBody.actions.forkAria')} onClick={() => void forkFrom(item.id)}><Icon name="git-branch" className="size-3.5" /></button>}
          {!readOnly && <button type="button" className="rounded-md p-1.5 hover:bg-interactive-hover disabled:opacity-40" disabled={pending || !snapshot || !providerId || !modelId}
            title={t('thread.message.summarize')} aria-label={t('thread.message.summarize')} onClick={() => { showOverview('memory'); void compactThrough(item.id); }}><Icon name="stack" className="size-3.5" /></button>}
        </div>
        {!readOnly && snapshot?.thread.bot_id && memorySelection && memoryHead && threadMemorySourceText(item) && <ThreadMemorySelection
          api={memorySelection} identity={{ ...identity, headId: memoryHead }} itemId={item.id} text={threadMemorySourceText(item)} />}
      </ThreadMessage>)}
      {!historyView && progress && <article className="mx-auto max-w-3xl" aria-label="Streaming assistant response"><MarkdownRenderer messageId={`${identity.threadId}:progress`} isStreaming content={progress} /></article>}
      {snapshot?.operations.filter(operation => operation.id !== pause?.action_id).map(operation => <div key={operation.id} className="mx-auto max-w-3xl">
        <ThreadPermission operation={operation} enabled={!readOnly && !pending && operation.run_id === run?.id && !run?.cancel_requested} onDecide={(permissionId, decision) => act(() => api.decidePermission({ ...identity, operationId: operation.id, permissionId, decision }))} />
        {operation.executor === 'ask_user' && <ThreadQuestion operation={operation} enabled={!readOnly && !pending && run?.state === 'waiting' && run.waiting_on === operation.waiting_on} onAnswer={answer => act(() => api.answerQuestion({ ...identity, operationId: operation.id, answer }))} />}
      </div>)}
      {!readOnly && snapshot && <ThreadMcpInteractions key={`mcp:${host}:${identity.threadId}:${identity.branchId}`} api={api} identity={identity} eventCursor={snapshot.eventCursor}
        models={models} selectedModel={samplingModel} modelError={modelError} />}
      {!readOnly && snapshot?.inputs.filter(input => input.state === 'queued').map(input => <ThreadQueuedInput key={`${host}:${identity.threadId}:${identity.branchId}:${input.id}:${input.revision}`}
        api={api} identity={identity} input={input} pending={pending}
        onSave={(text, images) => act(() => images === undefined ? api.editInput(input.id, input.revision, text) : api.editInput(input.id, input.revision, text, images))}
        onCancel={() => act(() => api.cancelInput(input.id, input.revision), true)} />)}
    </div>
    {readOnly && error && <p role="alert" className="px-4 text-sm text-destructive">{error}</p>}
    </div>
    {empty && <div className="min-h-6 flex-1" />}
    {!readOnly && <div className="chat-input-column mx-auto w-full max-w-[960px] shrink-0 space-y-5 px-4 pb-4 md:px-6">
    {empty && <div className="flex flex-col items-center gap-5 pb-1 text-center"><VarinLogo width={24} height={24} decorative className="text-muted-foreground" /><h1 className="text-2xl font-medium tracking-tight text-foreground md:text-3xl">{emptyWorkspacePath ? t('chat.emptyState.draftTitleWithProject', { project: formatDirectoryName(emptyWorkspacePath) }) : t('chat.emptyState.draftTitle')}</h1></div>}
    <form className="space-y-2" onSubmit={event => {
      event.preventDefault();
      if (sendDisabled || fileRead.current) return;
      const generation = identityGeneration.current;
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
          const submit = { ...identity, key, text: projectedText, images, ...attachments, expectedHead: branch?.head ?? null, model: { providerId, modelId, thinkingLevel }, ...(sourceForInput ? { source: sourceForInput.source } : {}) };
          const queued = { ...identity, key, text: projectedText, images, ...attachments, mode: inputMode };
          const continuation = { ...identity, key, text: projectedText, images, ...attachments, previousRunId: run?.id ?? '', expectedHead: branch?.head ?? null };
          if (!active && delegated && (!api.collaboration || !run)) throw new Error('Child continuation is unavailable');
          const goalSettings = useUIStore.getState();
          const goal = draft.goalArmed && !active && !delegated && text.trim() ? { goalObjective: text.trim(),
            ...(goalSettings.sessionGoalDefaultBudgetEnabled ? { goalBudget: goalSettings.sessionGoalDefaultBudget } : {}) } : {};
          pendingInput.current = { fingerprint, editorText: text, editorContext, inlineContext, preparedSource: sourceForInput, ...goal, status: 'sending', ...(active ? { kind: 'enqueue' as const, input: queued }
            : delegated ? { kind: 'continue' as const, input: continuation } : { kind: 'submit' as const, input: submit }) };
        }
        const original = pendingInput.current;
        await deliverThreadInput(api, original, next => {
          useThreadDraftStore.getState().patch(draftKey, current => current.pendingInput?.input.key === original.input.key ? { pendingInput: next } : {});
        });
        acknowledgeEditorContextAttachments(original.editorContext ?? []);
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
      });
    }}>
      {delegated && !active && <p role="status" className="text-sm text-muted-foreground">{preparingDelegation
        ? 'A delegated execution is preparing. Its original input remains accepted.'
        : 'Continue in a new Run using this child’s exact previous configuration and source selection. Previous reports and file results remain separate.'}</p>}
      {sourceCannotBeApplied && <p role="status" className="text-sm text-muted-foreground">The prepared workspace needs a new run. Keep the current workspace to queue this message, or wait for this run to finish.</p>}
      {pause && <p role="status" aria-label="Policy pause" className="text-sm text-muted-foreground">Paused: {pause.reason || 'Waiting for your explicit resume.'} Messages can be queued while paused.</p>}
      {policy?.preparation && <p role="status" aria-label="Strategy preparation" className="text-sm text-muted-foreground">{policy.preparation.status === 'preparing' ? 'The Host is preparing a strategy candidate.' : `The Host could not prepare the strategy candidate: ${policy.preparation.code ?? 'preparation failed'}`}</p>}
      {policyUpdatePending && <p role="status" aria-label="Policy update" className="text-sm text-muted-foreground">{policyUpdate?.status === 'preparing' ? 'Preparing the selected strategy. The current strategy remains active.' : 'Strategy prepared for the next closed decision boundary.'}{pause ? ' This run remains paused until you resume it.' : ''}</p>}
      {policyUpdate?.status === 'failed' && <p role="status" aria-label="Policy update failed" className="text-sm text-muted-foreground">{policyIncompatible ? 'The selected strategy cannot preserve this private checkpoint. The current strategy remains active. Restarting strategy state keeps conversation history and independent tasks.' : `Strategy update was not applied: ${policyUpdate.failure ?? 'preparation failed'}`}</p>}
      {snapshot?.launch?.preparation_failure && <p role="alert" className="text-sm text-destructive">Preparation needs attention: {threadSourceFailureMessage(snapshot.launch.preparation_failure) ?? snapshot.launch.preparation_failure}</p>}
      {draft.pendingInput?.status === 'unknown' && <p role="status" className="text-sm text-muted-foreground">{draft.pendingInput.kind === 'submit' && draft.pendingInput.acceptedRunId ? 'Message accepted. Retry finishes its Goal registration without sending the message again.' : 'Delivery is unconfirmed. Sending again checks the same original request; it does not create a second message.'}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {modelError && <p role="alert" className="text-sm text-destructive">{modelError}</p>}
      {snapshot?.modelSelection.desired?.status === 'failed' && <p role="alert" className="text-sm text-destructive">Model preparation failed: {snapshot.modelSelection.desired.failure}</p>}
      {snapshot?.modelSelection.desired && snapshot.modelSelection.desired.id !== snapshot.modelSelection.active?.id && snapshot.modelSelection.desired.status !== 'failed' && <p role="status" className="text-sm text-muted-foreground">Applies to the next model request</p>}
      {images.length > 0 && acceptsImages === false && <p role="alert" className="text-sm text-destructive">Choose an image-capable model or remove these images before sending</p>}
      <input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label="Choose image attachments"
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
      <input ref={pdfInput} type="file" accept="application/pdf,.pdf" multiple hidden aria-label={t('chat.fileAttachment.actions.choosePdfs')}
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
      <AutoReviewBanner identity={identity} />
      {draft.goalArmed && <p className="px-2 typography-meta text-primary">{t('thread.composer.goalArmed')}</p>}
      <ThreadComposer editorRef={messageInput} value={text} onChange={setText} models={models}
        providerId={providerId} modelId={modelId} thinkingLevel={thinkingLevel} onModelChange={selectModel}
        modelDisabled={pending || (delegated && !active)} attachmentDisabled={pending || Boolean(draft.pendingInput) || readingFiles}
        imageDisabled={acceptsImages === false} sendDisabled={sendDisabled} pending={pending} active={active} retrying={Boolean(draft.pendingInput)}
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
        <div className="space-y-2 px-3 empty:hidden">      <EditorContextAttachmentChips threadKey={draftKey} />
      {inlineContext.length > 0 && <div className="flex flex-wrap gap-1" aria-label="Attached context">
        {inlineContext.flatMap(bucket => bucket.drafts.map(item => <Button key={item.id} type="button" size="sm" variant="outline"
          title={item.text || item.fileLabel} onClick={() => useInlineCommentDraftStore.getState().acknowledgeDrafts(bucket.key, [item])}>
          {item.fileLabel} · {item.startLine}–{item.endLine} ×
        </Button>))}
      </div>}
      <ImageAttachmentStrip images={images} removeLabel={t('chat.fileAttachment.actions.removeImage')}
        onRemove={index => setImages(current => current.filter((_, candidate) => candidate !== index))} />
      <ThreadMaterialAttachments materials={materials} locked={pending || Boolean(draft.pendingInput)}
        onRemove={snapshotId => { if (!pendingAction.current && !pendingInput.current) setMaterials(current => current.filter(material => material.snapshotId !== snapshotId)); }} />
      {readingFiles && <p role="status">{t('chat.fileAttachment.uploading')}</p>}
        </div>
      </ThreadComposer>
      <div className="flex gap-2">
        {run && pause && <Button type="button" variant="outline" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.resume(run.id, pause.wait_id))}>Resume run</Button>}
        {active && run && policyUpdate && policyIncompatible && <Button type="button" variant="outline" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.restartPolicy(identity, run.id, policyUpdate.selection_id))}>Restart strategy state</Button>}
        {active && run && policyUpdate && policyUpdatePending && <Button type="button" variant="ghost" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.cancelPolicyUpdate(identity, run.id, policyUpdate.selection_id))}>Cancel strategy update</Button>}
        {run && launch?.startable && launch.requires_rebind && !pause && <Button type="button" variant="ghost" disabled={pending} onClick={() => void act(() => api.retryPreparation(run.id))}>Retry preparation</Button>}
      </div>
    </form>
    {empty && <DraftPresetChips cwd={draft.workspacePath ?? initialWorkspacePath} sessionId={identity.threadId} className="oc-draft-starters"
      onSubmit={starter => {
        if (starter.ref.type === 'command' && starter.ref.name === 'craft-goal') { useThreadDraftStore.getState().patch(draftKey, { goalArmed: true }); messageInput.current?.focus(); return; }
        if (starter.ref.type === 'command' && starter.ref.name === 'schedule-task') { useUIStore.getState().setScheduledTasksDialogOpen(true); return; }
        setText(current => [current.trimEnd(), starter.submitText].filter(Boolean).join('\n\n'));
        messageInput.current?.focus();
      }} />}
    </div>}
    {empty && <div className="min-h-6 flex-1" />}
  </section></ThreadMaterials>;
}
