import { THINKING_LEVELS, documentMimeType, DOCUMENT_FILE_ACCEPT } from '@varin/protocol';
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
import { attachProcessTerminal } from '@/lib/attachProcessTerminal';
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
import type { ImageAttachment } from '@varin/protocol';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { fileToImageAttachment } from '@/components/chat/composer/imageAttachments';
import { fileToBase64 } from '@/components/chat/composer/fileAttachments';
import { useI18n } from '@/lib/i18n';
import { runFailureMessage } from '@/lib/agent-runtime/runFailure';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import React from 'react';
import { tapHaptic } from '@/lib/motion/haptics';
import { createModelConnectionsHttpAPI, threadSourceFailureMessage, ThreadRequestError, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadModel, ThreadModelInfo, ThreadThinkingLevel, ThreadSnapshot, ThreadsAPI, ThreadPreparedSource } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { ThreadComposer } from './ThreadComposer';
import { useThreadNextStep } from './useThreadNextStep';
import { ThreadAgentControls } from './ThreadAgentControls';
import { useThreadWorkFocus } from './useThreadWorkFocus';
import { DraftPresetChips } from '@/components/chat/DraftPresetChips';
import { Departure } from '@/components/motion/Departure';
import { useUIStore } from '@/stores/useUIStore';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import type { OverviewPeekSection } from './WorkOverviewControl';
import { ThreadOverview } from './ThreadOverview';
import { useWorkOverviewStore } from '@/stores/useWorkOverviewStore';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { cn, formatDirectoryName } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ThreadProjection, type StreamingTextPart } from '@/lib/agent-runtime/thread-projection';
import { threadHistoryWindow } from '@/lib/agent-runtime/thread-history';
import { ThreadInputQueue } from './ThreadQueuedInput';

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
  const historyWindow = React.useMemo(() => threadHistoryWindow(api, String(host), { runtime: identity.runtime, threadId: identity.threadId, branchId: identity.branchId }), [api, host, identity.runtime, identity.threadId, identity.branchId]);
  const history = React.useSyncExternalStore(historyWindow.subscribe, historyWindow.getSnapshot, historyWindow.getSnapshot);
  const navigationEnabled = useUIStore(state => state.promptNavigatorEnabled);
  React.useEffect(() => { historyWindow.enableNavigation(navigationEnabled); }, [historyWindow, navigationEnabled]);
  const scrollMode = useTimelineViewStore(state => state.views[draftKey]?.scrollMode ?? 'following-end');
  const identityGeneration = React.useRef(0);
  const forkKeys = React.useRef(new Map<string, string>());
  const compactionKeys = React.useRef(new Map<string, string>());
  const [progress, setProgress] = React.useState<StreamingTextPart[]>([]);
  const [streamingTools, setStreamingTools] = React.useState<import('@/lib/agent-runtime/thread-projection').StreamingToolCall[]>([]);
  const [toolProgress, setToolProgress] = React.useState<import('@/lib/agent-runtime/thread-projection').ToolExecutionProgress[]>([]);
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
    setPreparingSource(false);
    pendingAction.current = null; setPending(false); setError(undefined);
    setSnapshot(undefined); setProgress([]); setToolProgress([]); setHistoryOpen(false); setContextRunId(undefined); setReadingFiles(false); fileReadGeneration.current += 1;
    fileRead.current?.abort(); fileRead.current = null;
    const view = new ThreadProjection(api, identity, value => { snapshotHost.current = host; historyWindow.accept(value); handoff.observe(value); setSnapshot(value); }, value => setError(value instanceof Error ? value.message : 'Thread unavailable'), setProgress, setStreamingTools, setToolProgress);
    projection.current = view; view.start();
    return () => { identityGeneration.current += 1; fileReadGeneration.current += 1; fileRead.current?.abort(); fileRead.current = null; view.close(); };
  }, [api, identity, host, handoff, historyWindow]);
  const snapshot = snapshotHost.current === host && snapshotState?.identity.threadId === identity.threadId && snapshotState?.identity.branchId === identity.branchId ? snapshotState : undefined;
  React.useEffect(() => {
    if (!snapshot || scrollMode !== 'following-end' || history.connecting || typeof document === 'undefined') return;
    const acknowledge = () => {
      if (document.visibilityState !== 'hidden' && host === getRuntimeEndpointGeneration()) {
        void useThreadStore.getState().markRead(identity.threadId, snapshot.thread.activity_cursor).catch(() => {});
      }
    };
    acknowledge();
    document.addEventListener('visibilitychange', acknowledge);
    return () => document.removeEventListener('visibilitychange', acknowledge);
  }, [snapshot, scrollMode, history.connecting, host, identity.threadId]);
  const workRevision = snapshot ? JSON.stringify([snapshot.activeRun?.id, snapshot.activeRun?.state,
    snapshot.children?.map(child => [child.child_thread_id, child.state])]) : null;
  React.useEffect(() => { if (workRevision) onWorkChanged?.(); }, [workRevision, onWorkChanged]);
  const branch = snapshot?.thread.branches.find(value => value.branch_id === identity.branchId);
  const run = snapshot?.activeRun ?? branch?.latest_run;
  const runFailure = snapshot?.runFailure?.runId === run?.id ? snapshot?.runFailure : null;
  const samplingConfiguration = (snapshot?.modelSelection.active?.configuration ?? run?.configuration) as
    { providerId?: string; model?: string; thinkingLevel?: ThreadThinkingLevel; catalogModelId?: string; modelOptions?: { temperature?: number } } | undefined;
  const samplingModel: ThreadModel | undefined = samplingConfiguration?.providerId && samplingConfiguration.model ? {
    providerId: samplingConfiguration.providerId, modelId: samplingConfiguration.catalogModelId ?? samplingConfiguration.model,
    ...(samplingConfiguration.thinkingLevel === undefined ? {} : { thinkingLevel: samplingConfiguration.thinkingLevel }),
    ...(samplingConfiguration.modelOptions?.temperature === undefined ? {} : { temperature: samplingConfiguration.modelOptions.temperature }),
  } : undefined;
  const active = Boolean(branch?.active_run_id);
  // A run that finishes in the conversation on screen taps once (§3.14); a failed one says so instead.
  const finishedRun = React.useRef<{ key: string; active: boolean } | null>(null);
  const runKey = `${identity.threadId}\0${identity.branchId}`;
  React.useEffect(() => {
    const previous = finishedRun.current;
    finishedRun.current = { key: runKey, active };
    if (previous?.key !== runKey || !previous.active || active || runFailure) return;
    if (typeof document === 'undefined' || document.visibilityState === 'visible') tapHaptic();
  }, [runKey, active, runFailure]);
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
    const isDocument = (file: File) => !!documentMimeType(file.name, file.type);
    setReadingFiles(true); setError(undefined);
    try {
      if (files.some(file => !isDocument(file) && !file.type.startsWith('image/'))) throw new Error(t('chat.fileAttachment.unsupportedType'));
      if (acceptsImages === false && files.some(file => !isDocument(file))) throw new Error('The selected model does not accept images');
      for (const file of files) {
        if (!current()) return;
        if (isDocument(file)) {
          const data = await fileToBase64(file);
          if (!current()) return;
          const result = await api.materials.upload(identity, { filename: file.name, mimeType: documentMimeType(file.name, file.type)!, data }, controller.signal);
          if (!current()) return;
          const retained = result.status === 'ok' ? result.sourceSnapshot ?? result.snapshot : undefined;
          if (!retained?.snapshotId || !retained.document?.source) throw new Error(t('chat.fileAttachment.pdfNotRetained'));
          const material = { snapshotId: retained.snapshotId, filename: file.name, sourceHash: retained.document.source.contentHash, format: retained.document.kind };
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
  const returnToLatest = () => {
    const store = useTimelineViewStore.getState();
    store.completeTimelineReturn(draftKey, store.requestTimelineReturn(draftKey));
  };
  const recovery = useThreadRecovery({ api, identity, host, snapshot, disabled: readOnly || active || actionPending || Boolean(draft.pendingInput), onRecovered: async editor => {
    returnToLatest(); pendingInput.current = undefined; setPreparedSource(null);
    if (editor.editorText !== undefined) setText(editor.editorText);
    if (editor.editorImages !== undefined) setImages(editor.editorImages);
    await projection.current?.refresh();
  } });
  const pending = actionPending || recovery.blocked || draft.firstSend?.status === 'sending';
  const nextStep = useThreadNextStep(api, identity, { owner: `${host}:${draftKey}`, runId: run?.id, headId: branch?.head,
    eligible: Boolean(!readOnly && snapshot && !active && !snapshot.thread.parent_thread_id && !snapshot.thread.bot_id
      && run && ['completed', 'failed', 'cancelled'].includes(run.state) && !pending && !draft.pendingInput && !draft.firstSend) });
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
  const visibleHistory = history.items;
  const firstMessage = useFirstMessagePreview(draftKey, Boolean(snapshot?.historyPage.head), handoff);
  const memorySelection = getRegisteredRuntimeAPIs()?.bots?.selection;
  const submissionFingerprint = () => JSON.stringify([identity.threadId, identity.branchId, projectedText, requestImages, materials, providerId, modelId, thinkingLevel, inputMode, preparedSource?.source, agent]);
  const sourceCannotBeApplied = active && Boolean(preparedSource) && !pendingInput.current;
  const sendBlocked = pending || (!draft.pendingInput && (!snapshot || preparingDelegation || preparingSource || sourceCannotBeApplied || readingFiles
    || (images.length > 0 && acceptsImages === false)
    || (!active && (delegated ? !api.collaboration || !run : !providerId || !modelId))));
  const hasComposerInput = Boolean(text.trim() || images.length || materials.length || inlineDrafts.length || editorContext.length);
  const sendDisabled = sendBlocked || (!draft.pendingInput && !hasComposerInput);
  const overviewKey = draftKey;
  const disclosure = useWorkOverviewStore(state => state.setDisclosure);
  const contentOwner = `${host}:${draftKey}`;
  const [focusedOverview, setFocusedOverview] = React.useState<{ owner: string; section: OverviewPeekSection }>();
  const [questionReveal, setQuestionReveal] = React.useState(0);
  const [questionOperation, setQuestionOperation] = React.useState<string>();
  const permissions = React.useRef<HTMLDivElement>(null);
  const showOverview = (section: OverviewPeekSection) => {
    setFocusedOverview({ owner: contentOwner, section });
    disclosure(overviewKey, 'overview', true);
  };
  const hasSummaries = Boolean(snapshot?.context.checkpoint?.proposal.summary.trim() || snapshot?.context.jobs.length);
  const empty = Boolean(snapshot && !visibleHistory.length && !progress.length && !active && !firstMessage.message && !pending && !draft.pendingInput);
  // The empty home animates away only when this view is sending; arriving history or a switch replaces it at once.
  const sendDeparts = Boolean(snapshot && (pending || draft.pendingInput || draft.firstSend || firstMessage.message));
  const emptyWorkspacePath = preparedSource?.path ?? draft.workspacePath ?? launch?.selection.source?.live_root?.canonicalRoot;
  const overview = <ThreadOverview key={contentOwner} api={api} identity={identity} sessionKey={overviewKey} snapshot={snapshot}
    request={focusedOverview?.owner === contentOwner ? focusedOverview : undefined} pending={pending} readOnly={readOnly}
    workspacePath={emptyWorkspacePath} hasComputer={hasComputer} error={error}
    recoveryAttention={recovery.error || recovery.unavailable || undefined}
    onAttention={() => {
      if (snapshot?.operations.some(operation => operation.executor === 'ask_user' && operation.phase !== 'terminal')) setQuestionReveal(value => value + 1);
      else permissions.current?.scrollIntoView({ block: 'nearest' });
      disclosure(overviewKey, 'overview', false); disclosure(overviewKey, 'compact', false);
    }}
    refresh={async () => { await projection.current?.refresh(); }} act={act} openProcess={openProcessTerminal}
    details={{
      goals: !readOnly && snapshot ? <ThreadGoal api={api.goals} identity={identity} goals={snapshot.goals} sourceRunId={run?.id} refresh={async () => { await projection.current?.refresh(); }} /> : undefined,
      sources: <>{!readOnly && !delegated && <ThreadSourcePicker key={identity.branchId} api={api} identity={identity} initialPath={draft.workspacePath ?? initialWorkspacePath}
      onUseChatOnly={() => { useThreadDraftStore.getState().patch(draftKey, { workspacePath: undefined, preparedSource: null, sourceSelection: undefined }); }}
      active={active || pending} launch={snapshot?.launch ?? null} prepared={preparedSource} onPrepared={setPreparedSource} onPreparingChange={setPreparingSource} />}</>,
      context: <>{!readOnly && snapshot?.context.checkpoint && <ThreadResources checkpoint={snapshot.context.checkpoint} pending={pending}
      onAddSkill={addSkill}
      onRefresh={() => void act(() => api.resources.refresh({ ...identity, expectedRevision: snapshot.context.checkpoint!.revision }))} />}
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
    </details>}</>,
      memory: snapshot && (snapshot.thread.bot_id || snapshot.context.checkpoint?.personalization) ? <ThreadMemory key={identity.threadId} identity={identity} botId={snapshot.thread.bot_id} basis={snapshot.context.checkpoint?.personalization} /> : undefined,
      research: <>{!readOnly && api.research && <ThreadResearch key={`research:${host}:${identity.threadId}:${identity.branchId}`} api={api.research} materials={api.materials} identity={identity} sourceRunId={run?.id} />}</>,
      followups: <>{!readOnly && snapshot && <ThreadFollowups key={`${host}:${identity.threadId}:${identity.branchId}`} api={api.followups} family={api.family} mediaRead={api.mediaRead} research={api.research} identity={identity}
        run={run ?? undefined} operations={snapshot.operations} followups={snapshot.followups} pending={pending} act={act}
        cancelObservation={operationId => act(() => api.cancelOperation(operationId))} />}</>,
      recovery: <>{!readOnly && <ThreadRecovery recovery={recovery} disabled={active || actionPending} />}</>,
      computer: <>{!readOnly && hasComputer && <section className="mx-auto w-full max-w-3xl px-4" aria-label={t('computer.automation.title')}>
      <ComputerAutomationSection view={computer} directory={initialWorkspacePath ?? ''} />
    </section>}</>,
      threads: <>{delegated && <div className="mx-auto w-full max-w-3xl px-4"><ThreadExecutions key={`${host}:${identity.threadId}:${identity.branchId}`} api={api} identity={identity} executions={snapshot?.delegatedExecutions ?? []} /></div>}</>,
    }} />;
  return <ThreadMaterials api={api.materials} identity={identity} onAddRegion={readOnly ? undefined : region => {
    if (pendingAction.current) throw new Error('Wait for the current message before adding a PDF selection.');
    addContentReference(identity, { ref: `document-selection:${crypto.randomUUID()}`, title: region.title, image: region.image,
      source: { kind: 'document', snapshotId: region.snapshotId, sourceHash: region.sourceHash, page: region.page, region: region.region } });
    messageInput.current?.focus();
  }}><ReferenceNavigationContext.Provider value={referenceNavigation}><section ref={handoff.setRoot} className="regular-chat-view relative flex h-full min-h-0 min-w-0 [container-type:inline-size]" aria-label="Thread conversation" data-thread-conversation="true">
    <div className="thread-conversation-layout relative flex min-h-0 min-w-0 flex-1">
    <div className="thread-conversation-main relative min-h-0 min-w-0 flex-1">
    <div className="thread-conversation-content flex h-full min-h-0 min-w-0 flex-col">
    {run?.state === 'failed' && <div role="alert" aria-label="Run failed" className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-destructive">
      <p>{t('harness.threads.state.failed')}</p>
      {runFailure && <p className="break-words">{runFailureMessage(runFailure, t)}</p>}
    </div>}
    {run?.state === 'cancelled' && <p role="status" aria-label="Run cancelled" className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-muted-foreground">{t('harness.threads.state.cancelled')}</p>}
    {contextRunId && <ContextHistoryDialog key={`${draftKey}:${contextRunId}`} api={api} identity={identity} runId={contextRunId} onClose={() => setContextRunId(undefined)} />}
    {historyOpen && <ChatTreeDialog api={api} identity={identity} open onOpenChange={setHistoryOpen} busy={pending} recoverDisabled={active}
      onFork={entry => { void forkFrom(entry.id); }} onRecover={entry => { showOverview('recovery'); void recovery.recover(entry.id); }} />}
    <div className={cn('relative flex min-h-0 flex-1', empty && 'hidden')}>
    <ConversationSurface owner={String(host)} identity={draftKey} ready={Boolean(history.ready || snapshot || firstMessage.message)} loadingLabel={t('common.loading')}>
    <ConversationTimeline api={api} identity={identity} snapshot={history.connecting ? undefined : snapshot} history={visibleHistory}
      runUsage={history.usage} historyReset={history.reset} historyReady={history.ready}
      navigation={{ runs: history.runs, readPreview: historyWindow.readRunPreview, ensureItem: historyWindow.ensureItem, error: history.navigationError, retry: historyWindow.retryNavigation }}
      earlierHistory={{ available: Boolean(history.previous), loading: history.loading, error: history.error, latencyMs: history.latencyMs, load: historyWindow.loadEarlier }}
      liveUser={firstMessage.message} liveUserStatus={firstMessage.status}
      progress={snapshot && !history.connecting ? progress : []} streamingTools={snapshot && !history.connecting ? streamingTools : []} toolProgress={toolProgress} cwd={emptyWorkspacePath ?? ''} working={active && !history.connecting && !launch?.preparation_failure && !pause} readOnly={readOnly || !snapshot || history.connecting}
      memory={snapshot?.thread.bot_id ? memorySelection : undefined}
      onQuote={quote => { if (!readOnly && currentViewScope.current === viewScope) { setText(current => [current.trimEnd(), quote].filter(Boolean).join('\n\n')); messageInput.current?.focus(); } }}
      onQuestion={operationId => { setQuestionOperation(operationId); setQuestionReveal(value => value + 1); }}
      onFork={!readOnly && snapshot && !history.connecting && !pending && onBranchCreated ? id => void forkFrom(id) : undefined}
      onRecover={!readOnly && !history.connecting && !pending && !active && snapshot ? id => { showOverview('recovery'); void recovery.recover(id); } : undefined}
      footer={<><div ref={permissions}>{snapshot?.operations.filter(operation => operation.id !== pause?.action_id).map(operation => <div key={operation.id} className="mx-auto max-w-3xl">
        <ThreadPermission operation={operation} enabled={!readOnly && !history.connecting && operation.run_id === run?.id && !run?.cancel_requested} onDecide={(permissionId, decision) => api.decidePermission({ ...identity, operationId: operation.id, permissionId, decision })} />
      </div>)}</div>
      {!readOnly && snapshot && <ThreadMcpInteractions key={`mcp:${host}:${identity.threadId}:${identity.branchId}`} api={api} identity={identity} eventCursor={snapshot.eventCursor}
        models={models} selectedModel={samplingModel} modelError={modelError} />}
</>} />
    </ConversationSurface>
    {readOnly && error && <p role="alert" className="px-4 text-sm text-destructive">{error}</p>}
    </div>
    {empty && <div className="min-h-6 flex-1" />}
    {!readOnly && <div className="thread-composer-stack shrink-0 space-y-5 pb-4">
    {snapshot && <ThreadQuestions key={draftKey} scopeKey={draftKey} revealKey={questionReveal} revealOperationId={questionOperation} operations={snapshot.operations}
      enabled={operation => !history.connecting && run?.state === 'waiting' && !run.cancel_requested && run.waiting_on === operation.waiting_on}
      onRead={operation => api.operation(operation.id)} onCancel={operation => api.cancelOperation(operation.id)}
      onAnswer={(operation, answers) => api.answerQuestion({ ...identity, operationId: operation.id, answers })} />}
    {/* A send moves the title and starters out while the composer docks; loading history removes them at once. */}
    <Departure present={empty} animated={sendDeparts} exit="rise" className="chat-input-column flex flex-col items-center gap-5 pb-1 text-center"><VarinLogo width={24} height={24} decorative className="text-muted-foreground" /><h1 className="text-2xl font-medium tracking-tight text-foreground md:text-3xl">{emptyWorkspacePath ? t('chat.emptyState.draftTitleWithProject', { project: formatDirectoryName(emptyWorkspacePath) }) : t('chat.emptyState.draftTitle')}</h1></Departure>
    {snapshot && <ThreadWorkStrips key={`${host}:${identity.threadId}:${identity.branchId}`} api={api} identity={identity} goals={snapshot.goals} followups={snapshot.followups} pending={pending} act={act} onGoal={() => showOverview('goals')} onFollowups={() => showOverview('followups')} />}
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
        tapHaptic();
        handoff.submit(request.key, draftKey, handoff.captureDraft());
        void sendThreadDraft(api, draftKey, request).then(inputId => {
          if (inputId && host === getRuntimeEndpointGeneration()) handoff.accepted(request.key, inputId);
        }, () => { handoff.cancelSubmission(request.key); });
        return;
      }
      if (sendDisabled || fileRead.current) return;
      tapHaptic();
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
      {snapshot?.launch?.preparation_failure && <p role="alert" className="text-sm text-destructive">{t('chat.run.preparationFailed', { reason: snapshot.launch.preparation_failure_detail ?? threadSourceFailureMessage(snapshot.launch.preparation_failure) ?? snapshot.launch.preparation_failure })}</p>}
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
      <input ref={pdfInput} type="file" accept={DOCUMENT_FILE_ACCEPT} multiple hidden aria-label={t('chat.fileAttachment.actions.choosePdfs')}
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
      <AutoReviewBanner identity={identity} />
      {draft.goalArmed && <p className="px-2 typography-meta text-primary">{t('thread.composer.goalArmed')}</p>}
      <ThreadComposer onOpenHistory={() => setHistoryOpen(true)} identityKey={draftKey} placement={empty ? 'center' : 'bottom'}
        permissionWorkspacePath={active || !preparedSource ? (launch?.selection.source
          ? launch.selection.source.resource_owner.kind === 'local' ? launch.selection.source.live_root?.canonicalRoot : undefined
          : draft.workspacePath) : preparedSource.source.resourceOwner.kind === 'local' ? preparedSource.path : undefined}
        agentControls={!snapshot?.thread.bot_id && !delegated ? <ThreadAgentControls workFocus={workFocus} pending={active} disabled={pending || Boolean(draft.firstSend || draft.pendingInput)}
          onWorkFocusChange={workFocus => useThreadDraftStore.getState().patch(draftKey, { workFocus })} /> : undefined}
        messageHistory={visibleHistory.filter(item => item.source === 'user').slice().reverse().map(item => typeof item.content === 'string' ? item.content : typeof (item.content as { text?: unknown })?.text === 'string' ? (item.content as { text: string }).text : '')}
        onCompact={branch?.head && !active && providerId && modelId ? () => { showOverview('context'); void compactThrough(branch.head!); } : undefined}
        editorRef={messageInput} value={text} onChange={setText} models={models}
        suggestion={nextStep.text} suggestionError={nextStep.error} onSuggestionConsumed={nextStep.consume}
        providerId={providerId} modelId={modelId} thinkingLevel={thinkingLevel} onModelChange={selectModel}
        modelDisabled={pending || Boolean(draft.firstSend) || (delegated && !active)} attachmentDisabled={pending || Boolean(draft.firstSend || draft.pendingInput) || readingFiles}
        imageDisabled={acceptsImages === false} sendDisabled={draft.firstSend ? pending : nextStep.text && text.length === 0 && !hasComposerInput ? sendBlocked : sendDisabled} pending={pending} active={active} retrying={Boolean(draft.firstSend || draft.pendingInput)}
        delivery={inputMode} onDeliveryChange={setInputMode} allowNextRun={!delegated}
        onFiles={files => void addFiles(files)} onAttachImages={() => fileInput.current?.click()} onAttachPdfs={() => pdfInput.current?.click()}
        goalArmed={draft.goalArmed} onGoal={() => {
          if (active || delegated || snapshot?.goals.some(goal => goal.control !== 'complete' && goal.control !== 'cancelled')) showOverview('goals');
          else if (!draft.pendingInput) useThreadDraftStore.getState().patch(draftKey, { goalArmed: !draft.goalArmed });
        }} onStop={active && branch?.active_run_id ? () => void act(() => api.cancelRun(branch.active_run_id!), true) : undefined}
        attachmentNames={[...images.map(() => ''), ...materials.map(material => material.filename)]}
        hasInput={hasComposerInput}
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
    <Departure present={empty} animated={sendDeparts} exit="sink" stagger=".varin-draft-starters > *" className="conversation-starters"><DraftPresetChips cwd={draft.workspacePath ?? initialWorkspacePath} sessionId={identity.threadId} className="varin-draft-starters"
      onSubmit={starter => {
        if (starter.ref.type === 'command' && starter.ref.name === 'craft-goal') { useThreadDraftStore.getState().patch(draftKey, { goalArmed: true }); messageInput.current?.focus(); return; }
        if (starter.ref.type === 'command' && starter.ref.name === 'schedule-task') { useUIStore.getState().setScheduledTasksDialogOpen(true); return; }
        setText(current => [current.trimEnd(), starter.submitText].filter(Boolean).join('\n\n'));
        messageInput.current?.focus();
      }} /></Departure>
    </div>}
    {empty && <div className="min-h-6 flex-1" />}
    </div>
    </div>
    {overview}
    </div>
  </section></ReferenceNavigationContext.Provider></ThreadMaterials>;
}
