import { shareSnapshot } from '@/lib/agent-runtime/structural-sharing';
import { ThreadStreamingStore } from '@/lib/agent-runtime/thread-streaming-store';
import { countUiWork } from '@/lib/performance-observation';
import { prepareQuotedFiles } from '@/lib/agent-runtime/quoteAttachments';
import { draftImageReferences } from '@/lib/images/references';
import { flushUiSessions } from '@/lib/interactive-ui/sessions';
import { registerUiSender } from '@/lib/interactive-ui/compose';
import { freezeDraftContentReferences, acknowledgeDraftMarkers, insertDraftMarker, restoreDraftReferences, draftAttachmentImageReferences } from '@/lib/agent-editor/contentReferences';
import { DraftContentReferences } from './DraftContentReferences';
import { useThreadComposerWorkflows } from './useThreadComposerWorkflows';
import { useThreadComposerCommands } from './ThreadComposerCommands';
import { composerFileSelections, composerHistoryAttachments, selectComposerFile, removeComposerFile } from '@/components/chat/composer/submit/fileSelections';
import { ComposerSelectedFiles } from './ComposerSelectedFiles';
import { composerInputReferences } from '@/components/chat/composer/submit/references';
import { canRespondToQuestion } from './threadOperations';
import { useOpenThreadContext } from '@/lib/openThreadContext';
import { toast } from '@/components/ui';
import { ActiveEditorSuggestion } from '../conversation/ActiveEditorSuggestion';
import { MessageHandoff } from '../conversation/messageHandoff';
import { useTimelineViewStore } from '../conversation/timelineViewStore';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { openConversationTree } from '@/lib/openConversationTree';
import { useBotNavigation } from '@/lib/bots';
import { currentWorkbenchProfileId } from '@/lib/agent-runtime/threadNavigation';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import { useConversationTreeStore } from '@/stores/useConversationTreeStore';
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
import { useProjectsStore } from '@/stores/useProjectsStore';
import { projectModelSettingsId } from '@/lib/projectResolution';
import { useThreadStore, threadHostKey, threadComposerKey, selectedComposerKey } from '@/stores/useThreadStore';
import { useThreadDraftStore, EMPTY_THREAD_DRAFT, type ThreadPendingInput, type ThreadMaterialAttachment } from '@/stores/useThreadDraftStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { ThreadMaterials } from './ThreadMaterials';
import { ThreadMaterialAttachments } from './ThreadMaterialAttachments';
import { ComputerAutomationSection } from '@/components/thread/ComputerAutomationSection';
import { useComputerAutomation } from '@/stores/useComputerAutomation';
import { ThreadExecutions } from './ThreadExecutions';
import { ChildPreparation, ChildState } from '../conversation/childPresentation';
import { attachProcessTerminal } from '@/lib/attachProcessTerminal';
import { ThreadGoal } from './ThreadGoal';
import { ThreadFollowups } from './ThreadFollowups';
import { ThreadResearch } from './ThreadResearch';
import { ThreadMemory } from './ThreadMemory';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { ThreadPermission } from './ThreadPermission';
import { ThreadQuestions } from './ThreadQuestions';
import { ThreadWorkStrips } from './ThreadWorkStrips';
import { ThreadMcpInteractions } from './ThreadMcpInteraction';
import { ThreadSourcePicker } from './ThreadSourcePicker';
import { useThreadRecovery } from './useThreadRecovery';
import { ThreadRecovery } from './ThreadRecovery';
import type { ImageAttachment } from '@varin/protocol';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { removeDraftImage, updateDraftImage } from '@/components/chat/composer/imageAttachments';
import { prepareAnnotatedImages } from '@/lib/images/annotations';
import { prepareDraftMarkerImages, hasDraftInlineImages, convertDraftMarkerImagesToFiles } from '@/lib/agent-runtime/draftImages';
import { removeDraftFile, attachmentImageReferences, selectThreadFiles, prepareThreadFiles } from '@/lib/agent-runtime/fileAttachments';
import { ThreadFileDrafts } from './ThreadAttachments';
import { useI18n } from '@/lib/i18n';
import { runFailureMessage } from '@/lib/agent-runtime/runFailure';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import React from 'react';
import { tapHaptic } from '@/lib/motion/haptics';
import { createModelConnectionsHttpAPI, defaultConversationModel, threadSourceFailureMessage, ThreadRequestError, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadModel, ThreadModelInfo, ThreadThinkingLevel, ThreadSnapshot, ThreadsAPI, ThreadPreparedSource } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { ThreadComposer } from './ThreadComposer';
import { useThreadNextStep } from './useThreadNextStep';
import { threadConfigurationModel, useThreadModelSelection } from './useThreadModelSelection';
import { ThreadAgentControls } from './ThreadAgentControls';
import { useThreadWorkFocus } from './useThreadWorkFocus';
import { DraftPresetChips } from '@/components/chat/DraftPresetChips';
import { Departure } from '@/components/motion/Departure';
import { useUIStore } from '@/stores/useUIStore';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import type { OverviewPeekSection } from './WorkOverviewControl';
import { ThreadOverview } from './ThreadOverview';
import { ConversationScrollbar } from '../conversation/ConversationScrollbar';
import { useWorkOverviewStore } from '@/stores/useWorkOverviewStore';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { cn, formatDirectoryName } from '@/lib/utils';
import { ThreadProjection } from '@/lib/agent-runtime/thread-projection';
import { threadHistoryWindow } from '@/lib/agent-runtime/thread-history';
import { ThreadInputQueue } from './ThreadQueuedInput';
import { threadLiveActivity, type ThreadLiveActivity } from './threadLiveActivity';

const EMPTY_MODELS: ThreadModelInfo[] = [];

const resourceErrorMessages = new Map([
  ['resource-missing', 'This skill or resource is missing from the current snapshot. Refresh instructions and skills, then try again.'],
  ['resource-invalid', 'This skill or resource could not be prepared. Check the skill definition or command, then try again.'],
  ['resource-denied', 'Access to this skill or resource was denied. Check workspace permissions and project trust before retrying.'],
  ['resource-unavailable', 'This skill or resource is unavailable right now. Refresh instructions and skills, then try again.'],
  ['resource-stale', 'This skill or resource has changed. Refresh instructions and skills, then try again.'],
  ['resource-cancelled', 'Skill or resource preparation was cancelled. Try again when ready.'],
]);

export function ThreadConversation({ api, identity, onBranchCreated, initialWorkspacePath, preferredModel: configuredPreferredModel, inheritWorkbenchModel = false, configurationReady = true, onWorkChanged, onActivity, readOnly = false, messageHandoff, emptyHero, surface = 'workbench' }: { surface?: 'workbench' | 'bot'; emptyHero?: { visual: React.ReactNode; title: string }; messageHandoff?: MessageHandoff; onWorkChanged?: () => void;
  /** Peripheral observers (the Bot figure) follow what the current Run visibly does; null once unmounted. */
  onActivity?: (activity: ThreadLiveActivity | null) => void;
  preferredModel?: ThreadModel | null; inheritWorkbenchModel?: boolean; configurationReady?: boolean; readOnly?: boolean; api: ThreadsAPI; identity: ThreadIdentity; onBranchCreated?: (identity: ThreadIdentity) => void; initialWorkspacePath?: string }) {
  const botSurface = surface === 'bot';
  const { t } = useI18n();
  const openThreadContext = useOpenThreadContext();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const draftKey = threadComposerKey(threadHostKey(), identity);
  const viewScope = React.useMemo(() => ({ api, host, draftKey, readOnly }), [api, host, draftKey, readOnly]);
  const referenceNavigation = React.useMemo<ReferenceNavigation>(() => ({ identity: { runtime: identity.runtime, threadId: identity.threadId, branchId: identity.branchId } }), [identity.runtime, identity.threadId, identity.branchId]);
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
  const followUpBehavior = useMessageQueueStore(state => state.followUpBehavior);
  const botFollowUpBehavior = useMessageQueueStore(state => state.botFollowUpBehavior);
  const submitMode = React.useRef<'boundary' | 'next_run' | undefined>(undefined);
  const { text, images, materials } = draft;
  // Source selection belongs to this conversation, not to its Shell or classification.
  const workspacePath = draft.workspacePath;
  const preparedSource = draft.preparedSource;
  React.useSyncExternalStore(subscribeEditorContextAttachments, getEditorContextAttachmentsRevision, () => 0);
  const editorContext = listEditorContextAttachments(threadHostKey(), draftKey);
  const inlineBuckets = useInlineCommentDraftStore(state => state.drafts);
  const inlineContext = React.useMemo(() => Object.entries(inlineBuckets).flatMap(([key, drafts]) => {
    const captured = drafts.filter(item => item.sessionKey === draftKey);
    return captured.length ? [{ key, drafts: captured }] : [];
  }), [inlineBuckets, draftKey]);
  const inlineDrafts = inlineContext.flatMap(bucket => bucket.drafts);
  const pendingInput = React.useMemo(() => ({
    get current() { return useThreadDraftStore.getState().drafts[draftKey]?.pendingInput; },
    set current(pendingInput: ThreadPendingInput | undefined) { useThreadDraftStore.getState().patch(draftKey, { pendingInput }); },
  }), [draftKey]);
  const fileInput = React.useRef<HTMLInputElement | null>(null);
  const pdfInput = React.useRef<HTMLInputElement | null>(null);
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
  const streaming = React.useMemo(() => new ThreadStreamingStore(), [api, host, identity]);
  const hasProgress = React.useSyncExternalStore(streaming.subscribe, streaming.getHasProgress, streaming.getHasProgress);
  if (import.meta.env.DEV) countUiWork('conversation.render');
  const messageInput = React.useRef<ComposerEditorHandle | null>(null);
  const [modelCatalog, setModelCatalog] = React.useState<{ api: ThreadsAPI; host: number; models: ThreadModelInfo[] }>();
  const modelsReady = modelCatalog?.api === api && modelCatalog.host === host;
  const models = modelsReady ? modelCatalog.models : EMPTY_MODELS;
  // Capture the ordinary workbench/IDE selection when entering an unconfigured
  // Bot conversation. Do not turn another conversation's later edits into a binding.
  const workbenchModel = React.useMemo(() => {
    if (!inheritWorkbenchModel || host !== getRuntimeEndpointGeneration()) return null;
    const navigation = useThreadStore.getState();
    if (navigation.hostKey !== threadHostKey()) return null;
    const key = selectedComposerKey(navigation);
    if (!key || key === draftKey) return null;
    return useThreadDraftStore.getState().drafts[key]?.model ?? null;
  }, [inheritWorkbenchModel, draftKey, host]);
  const inheritedModel = workbenchModel && models.some(model => model.providerId === workbenchModel.providerId && model.modelId === workbenchModel.modelId)
    ? { ...defaultConversationModel({ defaultProvider: workbenchModel.providerId, defaultModel: workbenchModel.modelId, defaultThinkingLevel: workbenchModel.thinkingLevel }, models)!,
      ...(workbenchModel.temperature === undefined ? {} : { temperature: workbenchModel.temperature }) } : null;
  const preferredModel = inheritedModel ?? configuredPreferredModel;
  const [modelError, setModelError] = React.useState<string>();
  const [defaultsVersion, refreshDefaults] = React.useReducer(version => version + 1, 0);
  React.useEffect(() => {
    let active = true; let request = 0;
    setModelCatalog(undefined); setModelError(undefined);
    const refresh = () => {
      const current = ++request;
      void api.listModels().then(value => {
        if (active && current === request) { setModelCatalog({ api, host, models: value }); setModelError(undefined); }
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
  const [loadFailure, setLoadFailure] = React.useState<{ scope: typeof viewScope; message: string }>();
  const loadError = loadFailure?.scope === viewScope ? loadFailure.message : undefined;
  const loadingTitle = useThreadStore(state => state.threads.find(thread => thread.thread_id === identity.threadId)?.title);
  const resourceFailure = React.useRef<{ snapshotId: string | null; message: string } | null>(null);
  const [actionPending, setPending] = React.useState(false);
  const pendingAction = React.useRef<object | null>(null);
  const projection = React.useRef<ThreadProjection | undefined>(undefined);
  React.useEffect(() => {
    identityGeneration.current += 1; forkKeys.current.clear(); compactionKeys.current.clear();
    setPreparingSource(false);
    pendingAction.current = null; resourceFailure.current = null; setPending(false); setError(undefined);
    setSnapshot(undefined); streaming.reset();
    const view = new ThreadProjection(api, identity, value => { snapshotHost.current = host; historyWindow.accept(value); handoff.observe(value); setSnapshot(value); setLoadFailure(undefined); }, value => setLoadFailure({ scope: viewScope, message: value instanceof Error ? value.message : 'Thread unavailable' }), streaming.publishProgress, streaming.publishTools, streaming.publishToolProgress);
    projection.current = view; view.start();
    return () => { identityGeneration.current += 1; view.close(); streaming.reset(); };
  }, [api, identity, host, handoff, historyWindow, viewScope, streaming]);
  const snapshot = snapshotHost.current === host && snapshotState?.identity.threadId === identity.threadId && snapshotState?.identity.branchId === identity.branchId ? snapshotState : undefined;
  const defaultProjectId = snapshot?.creationDefaults?.projectId;
  const defaultSource = snapshot?.creationDefaults?.source;
  const defaultProject = useProjectsStore(state => defaultProjectId ? state.projects.find(project => project.id === defaultProjectId) : undefined);
  const creationDefaultsPending = Boolean(defaultProjectId && !snapshot?.context.checkpoint?.resources && !snapshot?.thread.branches.some(branch => branch.latest_run)
    && !draft.creationDefaultsApplied && !draft.sourceDisabled && !draft.sourceSelection && !draft.workspacePath && !draft.preparedSource);
  React.useEffect(() => {
    if ((!defaultSource && !defaultProject) || snapshot?.context.checkpoint?.resources || snapshot?.thread.branches.some(branch => branch.latest_run)) return;
    const selected = defaultSource ?? { resourceOwner: defaultProject!.source?.resourceOwner ?? { kind: 'local' as const }, path: defaultProject!.path };
    useThreadDraftStore.getState().patch(draftKey, current => current.creationDefaultsApplied || current.sourceDisabled || current.firstSend || current.pendingInput ? {}
      : current.projectId || current.sourceSelection || current.workspacePath || current.preparedSource ? { creationDefaultsApplied: true } : {
      ...(defaultProjectId ? { projectId: defaultProjectId } : {}), identity, creationDefaultsApplied: true,
      ...(selected.resourceOwner.kind !== 'managed_host' ? { workspacePath: selected.path } : {}),
      sourceSelection: { resourceOwner: selected.resourceOwner, path: selected.path,
        ...(defaultSource?.workspaceId ? { expectedWorkspaceId: defaultSource.workspaceId } : {}),
        ...(defaultSource?.selection ? {selection:defaultSource.selection} : {}),
        mode: defaultSource?.selection?.mode ?? 'live_root', contentMode: 'saved-files', captureScopes: [] },
    });
  }, [defaultSource, defaultProjectId, defaultProject, snapshot, draftKey, identity]);
  const activityObserver = React.useRef(onActivity);
  activityObserver.current = onActivity;
  const observed = Boolean(onActivity);
  React.useEffect(() => {
    if (!observed || !snapshot) { activityObserver.current?.(null); return; }
    let previous: ThreadLiveActivity | undefined;
    const publish = () => {
      const { streamingTools, progressActivity } = streaming.getSnapshot();
      const next = shareSnapshot(previous, threadLiveActivity(snapshot, streamingTools, progressActivity));
      if (next !== previous) { previous = next; activityObserver.current?.(next); }
    };
    publish();
    return streaming.subscribe(publish);
  }, [observed, snapshot, streaming]);
  React.useEffect(() => () => activityObserver.current?.(null), []);
  React.useEffect(() => {
    const failure = resourceFailure.current, resourceId = snapshot?.context.checkpoint?.resources?.snapshot.id;
    if (failure && resourceId && resourceId !== failure.snapshotId) {
      resourceFailure.current = null;
      setError(current => current === failure.message ? undefined : current);
    }
  }, [snapshot, error]);
  React.useEffect(() => {
    if (!snapshot || snapshot.thread.activity_cursor <= snapshot.thread.read_cursor || scrollMode !== 'following-end' || history.connecting || typeof document === 'undefined') return;
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
  const samplingModel = threadConfigurationModel(snapshot?.modelSelection.active?.configuration ?? run?.configuration);
  const active = Boolean(branch?.active_run_id);
  const delegated = Boolean(snapshot?.delegatedExecutions?.length);
  const selectedModel = useThreadModelSelection({ draftKey, draft, ready: Boolean(snapshot), active, delegated,
    runId: run?.id, runModel: threadConfigurationModel(snapshot?.modelSelection.desired?.configuration ?? snapshot?.modelSelection.active?.configuration ?? run?.configuration),
    preferredModel, inheritWorkbenchModel, preferenceReady: configurationReady && (!inheritWorkbenchModel || modelsReady), models });
  const { providerId, modelId, temperature } = selectedModel;
  const thinkingLevel = selectedModel.thinkingLevel ?? 'off';
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
  const preparingExecution = snapshot?.delegatedExecutions?.find(execution => execution.state === 'preparing' && !execution.cancel_requested);
  const preparingDelegation = Boolean(preparingExecution);
  const botSession = Boolean(snapshot?.thread.bot_id && !snapshot.thread.parent_thread_id);
  const inputMode = !delegated && (botSession ? botFollowUpBehavior : followUpBehavior) === 'queue' ? 'next_run' as const : 'boundary' as const;
  const launch = snapshot?.launch?.run_id === run?.id ? snapshot?.launch : null;
  const workFocus = useThreadWorkFocus(draftKey, botSurface ? undefined : workspacePath ?? launch?.selection.source?.live_root?.canonicalRoot ?? initialWorkspacePath, launch?.selection.agent?.workFocus, Boolean(snapshot) && !botSurface && !creationDefaultsPending);
  const agent = { profileId: null, workFocus };
  const pause = run?.state === 'waiting' && launch?.pause?.wait_id === run.waiting_on ? launch.pause : null;
  const policy = snapshot?.policySelection;
  const policyUpdate = policy?.desired && policy.desired.run_id === run?.id ? policy.desired : null;
  const policyUpdatePending = policyUpdate?.status === 'preparing' || policyUpdate?.status === 'ready';
  const policyIncompatible = policyUpdate?.status === 'failed' && policyUpdate.failure === 'policy_state_incompatible';
  const acceptsImages = active || delegated ? (run?.configuration as { acceptsImages?: boolean } | undefined)?.acceptsImages
    : models.find(model => model.providerId === providerId && model.modelId === modelId)?.acceptsImages;
  const projectedText = projectEditorContextAttachments(appendInlineComments(text, inlineDrafts), editorContext, { includeImages: acceptsImages === true });
  const requestImages = images;
  const needsDefaultModel = Boolean(configurationReady && !creationDefaultsPending && snapshot && !run && preferredModel === undefined && !providerId && !modelId);
  React.useEffect(() => {
    if (!needsDefaultModel) return;
    const controller = new AbortController();
    const settingsWorkspace = draft.sourceDisabled ? undefined : workspacePath ?? initialWorkspacePath;
    void createModelConnectionsHttpAPI(host).readSettings(settingsWorkspace, controller.signal, projectModelSettingsId(useProjectsStore.getState().projects, draft.projectId, draft.sourceSelection)).then(settings => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      const effective = { ...settings.global, ...(settings.projectTrusted ? settings.project : {}) };
      const selection = defaultConversationModel(effective, models);
      if (!selection) return;
      useThreadDraftStore.getState().patch(draftKey, current => {
        if (current.model?.providerId || current.model?.modelId || current.workspacePath !== draft.workspacePath || current.projectId !== draft.projectId) return {};
        return { model: selection };
      });
    }).catch(failure => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [needsDefaultModel, host, draftKey, draft.workspacePath, draft.projectId, draft.sourceSelection, draft.sourceDisabled, workspacePath, initialWorkspacePath, botSurface, defaultsVersion, models]);
  const act = async (work: () => Promise<unknown>, interrupt = false, propagate = false) => {
    if (readOnly || currentViewScope.current !== viewScope || pendingAction.current && !interrupt) { if (propagate) throw new Error(t('composer.menu.unavailable')); return; }
    const action = {}; pendingAction.current = action;
    const generation = identityGeneration.current;
    const current = () => generation === identityGeneration.current && host === getRuntimeEndpointGeneration() && pendingAction.current === action;
    resourceFailure.current = null; setPending(true); setError(undefined); useThreadDraftStore.getState().patch(draftKey, { sendError: undefined });
    try { await work(); if (current()) await projection.current?.refresh(); }
    catch (value) {
      if (!current()) return;
      if (value instanceof ThreadRequestError && value.status === 409) await projection.current?.refresh();
      if (!current()) return;
      const resourceError = value instanceof ThreadRequestError ? threadSourceFailureMessage(value.code) ?? resourceErrorMessages.get(value.code) : undefined;
      if (value instanceof ThreadRequestError && value.code === 'resource-stale' && resourceError) {
        resourceFailure.current = { snapshotId: snapshot?.context.checkpoint?.resources?.snapshot.id ?? null, message: resourceError };
      }
      setError(resourceError ?? (value instanceof ThreadRequestError && ['kernel-frame-too-large', 'http-body-too-large'].includes(value.code)
        ? 'These images exceed the current transport request size. Remove or resize an image and retry; your attachments are still here.'
        : value instanceof ThreadRequestError && value.code === 'model-images-unsupported' ? 'The selected model does not accept images. Choose an image-capable model or remove the images.'
        : value instanceof Error ? value.message : 'Thread request failed'));
      if (propagate) throw value;
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
  const insertImageReference = (number: number) => {
    const object = useThreadDraftStore.getState().drafts[draftKey]?.markerObjects?.find(object => object.kind === 'image' && object.number === number);
    if (object) void insertDraftMarker(draftKey, object);
  };
  const addFiles = (files: File[]) => {
    if (!files.length || readOnly || pendingAction.current || pendingInput.current || useThreadDraftStore.getState().drafts[draftKey]?.firstSend) return;
    selectThreadFiles(draftKey, files);
  };
  const selectModel = (provider: string, model: string, thinking: ThreadThinkingLevel) => {
    if (active && run) {
      return act(()=>api.selectModel({...identity,runId:run.id,key:crypto.randomUUID(),model:{...selectedModel,providerId:provider,modelId:model,thinkingLevel:thinking}}), false, true);
    } else useThreadDraftStore.getState().patch(draftKey, { model: { ...selectedModel, providerId: provider, modelId: model, thinkingLevel: thinking } });
  };
  const returnToLatest = () => {
    const store = useTimelineViewStore.getState();
    store.completeTimelineReturn(draftKey, store.requestTimelineReturn(draftKey));
  };
  const recovery = useThreadRecovery({ api, identity, host, snapshot, disabled: readOnly || active || actionPending || Boolean(draft.pendingInput), onRecovered: async editor => {
    returnToLatest(); pendingInput.current = undefined; setPreparedSource(null);
    if (editor.editorText !== undefined) useThreadDraftStore.getState().patch(draftKey, restoreDraftReferences({ ...editor, identity }));
    else if (editor.editorImages !== undefined) setImages(editor.editorImages);
    await projection.current?.refresh();
  } });
  const pending = actionPending || recovery.blocked || draft.firstSend?.status === 'sending';
  const recoveryAttention = recovery.error || recovery.unavailable
    || (recovery.blocked || recovery.savedOperations.some(operation => operation.state === 'needs-attention')
      ? t('chat.recovery.attention') : undefined);
  const nextStep = useThreadNextStep(api, identity, { owner: `${host}:${draftKey}`, runId: run?.id, headId: branch?.head,
    eligible: Boolean(!readOnly && snapshot && !active && !snapshot.thread.parent_thread_id && !snapshot.thread.bot_id
      && run && ['completed', 'failed', 'cancelled'].includes(run.state) && !pending && !draft.pendingInput && !draft.firstSend) });
  const forkFrom = async (headId: string, propagate = false) => {
    const generation = identityGeneration.current;
    let key = forkKeys.current.get(headId);
    if (!key) { key = crypto.randomUUID(); forkKeys.current.set(headId, key); }
    const target = { ...identity };
    await act(async () => {
      await flushUiSessions(target, host);
      if (generation !== identityGeneration.current || host !== getRuntimeEndpointGeneration()) throw new Error(t('ui.content.actionsUnavailable'));
      const created = await api.fork({ ...target, key, headId });
      if (generation === identityGeneration.current) { forkKeys.current.delete(headId); onBranchCreated?.(created); }
    }, false, propagate);
  };
  const compactThrough = async (throughId: string) => {
    if (!snapshot) return;
    const generation = identityGeneration.current;
    const expectedRevision = snapshot.context.checkpoint?.revision ?? 0;
    const fingerprint = JSON.stringify([throughId, expectedRevision, providerId, modelId, thinkingLevel]);
    let key = compactionKeys.current.get(fingerprint);
    if (!key) { key = crypto.randomUUID(); compactionKeys.current.set(fingerprint, key); }
    try {
      await api.compact({ ...identity, key, throughId, expectedRevision, model: { providerId, modelId, thinkingLevel } });
      if (generation === identityGeneration.current) compactionKeys.current.delete(fingerprint);
    } catch (error) { if (generation === identityGeneration.current) toast.error(error instanceof Error ? error.message : String(error)); throw error; }
  };
  const visibleHistory = history.items;
  const firstMessage = useFirstMessagePreview(draftKey, Boolean(snapshot?.historyPage.head), handoff);
  const memorySelection = getRegisteredRuntimeAPIs()?.bots?.selection;
  const referenceScope = JSON.stringify([host, draftKey, preparedSource?.source ?? launch?.selection.source ?? workspacePath]);
  const submissionFingerprint = () => JSON.stringify([identity.threadId, identity.branchId, projectedText, draft.references, draft.markerObjects, draft.selectedAttachments, requestImages, materials, draft.files?.map(file => file.id), providerId, modelId, thinkingLevel, preparedSource?.source, draft.sourceDisabled, agent]);
  const sourceCannotBeApplied = active && Boolean(preparedSource) && !pendingInput.current;
  const sendBlocked = pending || (!draft.pendingInput && (!snapshot || preparingDelegation || preparingSource || sourceCannotBeApplied
    || (hasDraftInlineImages(draft) && acceptsImages === false)
    || (!active && (delegated ? !api.collaboration || !run : !providerId || !modelId))));
  const hasComposerInput = Boolean(text.trim() || images.length || materials.length || draft.files?.length || draft.selectedAttachments?.length || inlineDrafts.length || editorContext.length || draft.markerObjects?.length);
  const sendDisabled = sendBlocked || (!draft.pendingInput && !hasComposerInput);
  // Trusted platform buttons use the native input owner without consuming the composer.
  // Registration follows the exact visible Host/branch; retained attempts live in its draft.
  React.useLayoutEffect(() => registerUiSender(draftKey, async action => {
    if (readOnly || host !== getRuntimeEndpointGeneration() || currentViewScope.current !== viewScope
      || threadComposerKey(threadHostKey(), action.identity) !== draftKey) throw new Error(t('ui.content.sendUnavailable'));
    const store = useThreadDraftStore.getState();
    const fingerprint = JSON.stringify([action.text, action.reference?.source.kind === 'ui' ? action.reference.source.revisionRef : action.reference?.ref]);
    let attempt = store.drafts[draftKey]?.interactionSends?.[action.sourceKey];
    if (attempt?.receipt && attempt.fingerprint === fingerprint) return attempt.receipt;
    if (!attempt?.pending) {
      if (!snapshot || preparingDelegation || pending || (!active && (delegated ? !api.collaboration || !run : !providerId || !modelId))) {
        throw new Error(t('ui.content.sendUnavailable'));
      }
      const body = { ...identity, key: crypto.randomUUID(), text: action.text, contentReferences: action.reference ? [{ ...action.reference, number: 1 }] : undefined };
      const original: ThreadPendingInput = { fingerprint, editorText: action.text, status: 'sending',
        ...(active ? { kind: 'enqueue', input: { ...body, mode: inputMode } }
          : delegated ? { kind: 'continue', input: { ...body, previousRunId: run!.id, expectedHead: branch?.head ?? null } }
          : { kind: 'submit', input: { ...body, expectedHead: branch?.head ?? null,
            model: { providerId, modelId, thinkingLevel, ...(temperature === undefined ? {} : { temperature }) },
            ...(!botSurface && !snapshot.thread.bot_id ? { agent } : {}) } }) };
      attempt = { fingerprint, pending: original };
      store.patch(draftKey, current => ({ interactionSends: { ...current.interactionSends, [action.sourceKey]: attempt! } }));
    }
    const original = attempt.pending!;
    const update = (next: ThreadPendingInput | undefined) => store.patch(draftKey, current => {
      if (current.interactionSends?.[action.sourceKey]?.pending?.input.key !== original.input.key) return {};
      const sends = { ...current.interactionSends };
      if (next) sends[action.sourceKey] = { fingerprint: attempt!.fingerprint, pending: next };
      else delete sends[action.sourceKey];
      return { interactionSends: sends };
    });
    const inputId = await deliverThreadInput(api, original, update);
    const receipt = { status: original.kind === 'enqueue' ? 'queued' as const : 'sent' as const, ...(inputId ? { inputId } : {}) };
    store.patch(draftKey, current => current.interactionSends?.[action.sourceKey]?.pending?.input.key === original.input.key
      ? { interactionSends: { ...current.interactionSends, [action.sourceKey]: { fingerprint: attempt!.fingerprint, receipt } } } : {});
    if (host === getRuntimeEndpointGeneration() && currentViewScope.current === viewScope) void projection.current?.refresh();
    return receipt;
  }));
  const overviewKey = draftKey;
  const disclosure = useWorkOverviewStore(state => state.setDisclosure);
  const contentOwner = `${host}:${draftKey}`;
  const scrollbarOwner = `${contentOwner}:${history.reset}`;
  const currentScrollbarOwner = React.useRef(scrollbarOwner);
  currentScrollbarOwner.current = scrollbarOwner;
  const scrollbarTrack = React.useRef<HTMLDivElement>(null);
  const [scrollViewport, setScrollViewport] = React.useState<{ owner: string; element: HTMLElement } | null>(null);
  const bindScrollViewport = React.useCallback((element: HTMLElement | null) => {
    if (currentScrollbarOwner.current !== scrollbarOwner) return;
    setScrollViewport(previous => previous?.owner === scrollbarOwner && previous.element === element ? previous
      : element ? { owner: scrollbarOwner, element } : null);
  }, [scrollbarOwner]);
  const [focusedOverview, setFocusedOverview] = React.useState<{ owner: string; section: OverviewPeekSection }>();
  const [questionReveal, setQuestionReveal] = React.useState(0);
  const [questionOperation, setQuestionOperation] = React.useState<string>();
  const permissions = React.useRef<HTMLDivElement>(null);
  const showOverview = React.useCallback((section: OverviewPeekSection) => {
    if (section === 'context') { openThreadContext(identity, initialWorkspacePath, undefined, readOnly); return; }
    setFocusedOverview({ owner: contentOwner, section });
    disclosure(overviewKey, 'overview', true);
  }, [identity, initialWorkspacePath, readOnly, contentOwner, disclosure, overviewKey, openThreadContext]);
  const treeNavigation = useConversationTreeStore(state => state.navigation[draftKey]);
  React.useEffect(() => () => {
    queueMicrotask(() => {
      const selected = botSurface && currentWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID
        ? useBotNavigation.getState().entry : useThreadStore.getState().selectedIdentity;
      if (host === getRuntimeEndpointGeneration() && selected
          && threadComposerKey(threadHostKey(), selected) === draftKey) return;
      const command = useConversationTreeStore.getState().navigation[draftKey];
      if (command) useConversationTreeStore.getState().consume(draftKey, command.token);
    });
  }, [draftKey, host, botSurface]);
  React.useEffect(() => {
    if (treeNavigation?.kind !== 'recover' || !snapshot || history.connecting) return;
    useConversationTreeStore.getState().consume(draftKey, treeNavigation.token);
    if (readOnly || active || pending || draft.pendingInput) { toast.error(t('chat.tree.recoveryBusy')); return; }
    showOverview('recovery');
    void recovery.recover(treeNavigation.entryId);
  }, [treeNavigation, draftKey, snapshot, history.connecting, readOnly, active, pending, draft.pendingInput, recovery, showOverview, t]);
  const empty = Boolean(snapshot && !visibleHistory.length && !hasProgress && !active && !firstMessage.message && !pending && !draft.pendingInput);
  // The empty home animates away only when this view is sending; arriving history or a switch replaces it at once.
  const sendDeparts = Boolean(snapshot && (pending || draft.pendingInput || draft.firstSend || firstMessage.message));
  const emptyWorkspacePath = preparedSource?.path ?? workspacePath ?? launch?.selection.source?.live_root?.canonicalRoot;
  const localWorkspacePath = preparedSource?.source.resourceOwner.kind === 'local' ? preparedSource.path
    : launch?.selection.source?.resource_owner.kind === 'local' && launch.selection.source.mode === 'live_root' ? launch.selection.source.live_root?.canonicalRoot
    : !launch?.selection.source ? workspacePath : undefined;
  const composerCommands = useThreadComposerCommands({ api, identity, snapshot, sourcePath: localWorkspacePath, act, readOnly,
    disabled: pending || readOnly ? t('composer.menu.unavailable') : undefined, onHistory: () => openConversationTree(surface), onFork: head => forkFrom(head, true),
    refresh: async () => { await projection.current?.refresh(); }, onSources: () => showOverview('sources') });
  const workflows = useThreadComposerWorkflows({ api, identity, snapshot, draftKey, draftText: text, referenceScope: JSON.stringify([host, draftKey, launch?.selection.source ?? workspacePath]), onMemoryOpen: () => showOverview('memory'),
    refresh: () => { void projection.current?.refresh(); }, disabled: pending || readOnly ? t('composer.menu.unavailable') : undefined });
  const overview = (!botSurface || focusedOverview?.owner === contentOwner) && <ThreadOverview key={contentOwner} api={api} identity={identity} sessionKey={overviewKey} snapshot={snapshot}
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
      sources: <>{!readOnly && !delegated && <ThreadSourcePicker key={identity.branchId} api={api} identity={identity} initialPath={draft.sourceSelection?.path ?? draft.workspacePath ?? initialWorkspacePath} draftSelection={draft.sourceSelection}
      onUseChatOnly={() => { useThreadDraftStore.getState().patch(draftKey, { workspacePath: undefined, projectId: undefined, creationDefaultsApplied: true, preparedSource: null, sourceSelection: undefined, sourceDisabled: true }); }}
      active={active || pending} launch={snapshot?.launch ?? null} prepared={preparedSource} onPrepared={source => useThreadDraftStore.getState().patch(draftKey, { preparedSource: source, projectId: undefined, workspacePath: undefined, sourceSelection: undefined, ...(source ? { sourceDisabled: false } : {}), creationDefaultsApplied: true })} onPreparingChange={setPreparingSource} />}</>,
      context: <button type="button" onClick={() => openThreadContext(identity, initialWorkspacePath, undefined, readOnly)}>{t('harness.overview.contextDetails')}</button>,
      memory: snapshot && (snapshot.thread.bot_id || snapshot.context.checkpoint?.personalization) ? <ThreadMemory key={identity.threadId} identity={identity} botId={snapshot.thread.bot_id} basis={snapshot.context.checkpoint?.personalization} /> : undefined,
      research: <>{!readOnly && api.research && <ThreadResearch key={`research:${host}:${identity.threadId}:${identity.branchId}`} api={api.research} materials={api.materials} identity={identity} sourceRunId={run?.id} />}</>,
      followups: <>{!readOnly && snapshot && <ThreadFollowups key={`${host}:${identity.threadId}:${identity.branchId}`} api={api.followups} botId={snapshot.thread.bot_id} family={api.family} mediaRead={api.mediaRead} research={api.research} identity={identity}
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
    <div ref={scrollbarTrack} className="thread-conversation-layout relative flex min-h-0 min-w-0 flex-1">
    <div className="thread-conversation-main relative min-h-0 min-w-0 flex-1">
    <div className="thread-conversation-content flex h-full min-h-0 min-w-0 flex-col">
    {botSurface && !readOnly && recoveryAttention && <div role="status" className="chat-input-column flex items-center gap-3 py-2 typography-meta text-muted-foreground">
      <span className="min-w-0 flex-1 break-words">{recoveryAttention}</span>
      <Button variant="ghost" size="sm" onClick={() => showOverview('recovery')}>{t('chat.recovery.inspect')}</Button>
    </div>}
    {run?.state === 'failed' && <div role="alert" aria-label="Run failed" className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-destructive">
      <p>{t('harness.threads.state.failed')}</p>
      {runFailure && <p className="break-words">{runFailureMessage(runFailure, t)}</p>}
    </div>}
    {run?.state === 'cancelled' && <p role="status" aria-label="Run cancelled" className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-muted-foreground">{t('harness.threads.state.cancelled')}</p>}
    <div className={cn('relative flex min-h-0 flex-1', empty && 'hidden')}>
    {snapshot && loadError && <p role="alert" className="mx-auto w-full max-w-3xl break-words px-4 py-2 text-sm text-destructive">{loadError}</p>}
    <ConversationSurface owner={String(host)} identity={draftKey} ready={Boolean(history.ready || snapshot || firstMessage.message || loadError)} loadingLabel={[loadingTitle, t('common.loading')].filter(Boolean).join(' · ')}>
    {loadError && !snapshot ? <div role="alert" className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-3 px-6 py-8 text-sm">
      <p className="break-words text-destructive">{loadError}</p>
      <Button variant="outline" onClick={() => { setLoadFailure(undefined); void projection.current?.refresh(); }}>{t('harness.threads.history.retry')}</Button>
    </div> : <ConversationTimeline api={api} identity={identity} snapshot={history.connecting ? undefined : snapshot} history={visibleHistory}
      onOpenSection={showOverview}
      onScrollContainerChange={bindScrollViewport}
      runUsage={history.usage} historyReset={history.reset} historyReady={history.ready}
      navigation={{ runs: history.runs, readPreview: historyWindow.readRunPreview, ensureItem: historyWindow.ensureItem, error: history.navigationError, retry: historyWindow.retryNavigation }}
      earlierHistory={{ available: Boolean(history.previous), loading: history.loading, error: history.error, latencyMs: history.latencyMs, load: historyWindow.loadEarlier }}
      liveUser={firstMessage.message} liveUserStatus={firstMessage.status}
      streamingStore={streaming} streamingEnabled={Boolean(snapshot && !history.connecting)} cwd={emptyWorkspacePath ?? ''} working={active && !history.connecting && !launch?.preparation_failure && !pause} readOnly={readOnly || !snapshot || history.connecting}
      memory={snapshot?.thread.bot_id ? memorySelection : undefined}
      onQuote={quote => { if (!readOnly && currentViewScope.current === viewScope) { setText(current => [current.trimEnd(), quote].filter(Boolean).join('\n\n')); messageInput.current?.focus(); } }}
      onQuestion={operationId => { setQuestionOperation(operationId); setQuestionReveal(value => value + 1); }}
      onFork={!readOnly && snapshot && !history.connecting && !pending && onBranchCreated ? id => void forkFrom(id) : undefined}
      onRecover={!readOnly && !history.connecting && !pending && !active && snapshot ? id => { showOverview('recovery'); void recovery.recover(id); } : undefined}
      footer={<>{preparingExecution && <div role="status" className="mx-auto w-full max-w-3xl space-y-2 px-4 py-4">
        <div className="flex items-center gap-3 text-sm"><span>{preparingExecution.name ?? loadingTitle}</span><ChildState state={preparingExecution.state} /></div>
        <ChildPreparation progress={preparingExecution.preparation ?? { phase: 'source' }} />
      </div>}<div ref={permissions}>{snapshot?.operations.filter(operation => operation.id !== pause?.action_id).map(operation => <div key={operation.id} className="mx-auto max-w-3xl">
        <ThreadPermission operation={operation} enabled={!readOnly && !history.connecting && operation.run_id === run?.id && !run?.cancel_requested} onDecide={(permissionId, decision) => api.decidePermission({ ...identity, operationId: operation.id, permissionId, decision })} />
      </div>)}</div>
      {!readOnly && snapshot && <ThreadMcpInteractions key={`mcp:${host}:${identity.threadId}:${identity.branchId}`} api={api} identity={identity} eventCursor={snapshot.eventCursor}
        models={models} selectedModel={samplingModel} modelError={modelError} />}
</>} />}
    </ConversationSurface>
    {readOnly && error && <p role="alert" className="px-4 text-sm text-destructive">{error}</p>}
    </div>
    {empty && <div className="min-h-6 flex-1" />}
    {!readOnly && <div className="thread-composer-stack shrink-0 space-y-5 pb-4">
    {snapshot && <ThreadQuestions key={draftKey} scopeKey={draftKey} revealKey={questionReveal} revealOperationId={questionOperation} operations={snapshot.operations}
      enabled={operation => !history.connecting && canRespondToQuestion(operation, { run, launch: snapshot.launch })}
      onRead={operation => api.operation(operation.id)} onCancel={operation => api.cancelOperation(operation.id)}
      onAnswer={(operation, answers) => api.answerQuestion({ ...identity, operationId: operation.id, answers })} />}
    {/* A send moves the title and starters out while the composer docks; loading history removes them at once. */}
    <Departure present={empty} animated={sendDeparts} exit="rise" className="chat-input-column flex flex-col items-center gap-5 pb-1 text-center">{emptyHero?.visual ?? <VarinLogo width={24} height={24} decorative className="text-muted-foreground" />}<h1 className="text-2xl font-medium tracking-tight text-foreground md:text-3xl">{emptyHero?.title ?? (emptyWorkspacePath ? t('chat.emptyState.draftTitleWithProject', { project: formatDirectoryName(emptyWorkspacePath) }) : t('chat.emptyState.draftTitle'))}</h1></Departure>
    {!botSurface && snapshot && <ThreadWorkStrips key={`${host}:${identity.threadId}:${identity.branchId}`} api={api} identity={identity} goals={snapshot.goals} followups={snapshot.followups} pending={pending} act={act} onGoal={() => showOverview('goals')} onFollowups={() => showOverview('followups')} />}
    <div className="chat-input-column conversation-composer-queue">{snapshot && <ThreadInputQueue key={`${host}:${identity.threadId}:${identity.branchId}`}
      api={api} identity={identity} inputs={snapshot.inputs} pending={pending} reportDelivery={botSession}
      onSave={async (input, text, images, quotes) => {
        let saved = false;
        await act(async () => {
          const preparedImages = images === undefined ? undefined : await prepareAnnotatedImages(images);
          // Image export may outlive a Host switch. The API resolves its endpoint
          // at dispatch, so the original edit must not follow the new selection.
          if (host !== getRuntimeEndpointGeneration()) return;
          await api.editInput(input.id, input.revision, text, preparedImages, undefined, quotes);
          saved = true;
        });
        return saved;
      }} onCancel={input => act(() => api.cancelInput(input.id, input.revision), true)}
      onSendNow={active && run ? input => act(() => api.sendInputNow(input.id, input.revision, run.id)) : undefined} />}</div>
    {workflows.directed ?? <form className="space-y-2" onSubmit={event => {
      event.preventDefault();
      const requestedMode = submitMode.current ?? inputMode;
      submitMode.current = undefined;
      if (draft.firstSend || draft.identity && !run && (draft.sourceSelection || draft.files?.length)) {
        if (pending || !draft.firstSend && sendDisabled) return;
        try {
        const settings = useUIStore.getState();
        const request = draft.firstSend ?? { key: crypto.randomUUID(), status: 'sending' as const, editorText: text, text: projectedText,
          images: requestImages, imageObjects: draft.markerObjects, files: draft.files ?? [], selectedAttachments: draft.selectedAttachments, referenceScope, model: { providerId, modelId, thinkingLevel, ...(temperature === undefined ? {} : { temperature }) }, ...(!botSurface && !snapshot?.thread.bot_id && !delegated ? { agent } : {}), workspacePath,
          sourceSelection: draft.sourceSelection, sourceDisabled: draft.sourceDisabled, attachmentImageReferences: draftAttachmentImageReferences(draft), editorContext, inlineContext, markerObjectIds: draft.markerObjects?.map(object => object.id), markerOccurrenceIds: draft.references?.filter(reference => reference.target.kind === 'quote' || reference.target.kind === 'image').map(reference => reference.id), ...freezeDraftContentReferences(draft), ...composerInputReferences(text, draft.references, referenceScope),
          ...(draft.goalArmed && text.trim() ? { goalObjective: text.trim(), ...(settings.sessionGoalDefaultBudgetEnabled ? { goalBudget: settings.sessionGoalDefaultBudget } : {}) } : {}) };
        tapHaptic();
        handoff.submit(request.key, draftKey, handoff.captureDraft());
        void sendThreadDraft(api, draftKey, request).then(inputId => {
          if (inputId && host === getRuntimeEndpointGeneration()) handoff.accepted(request.key, inputId);
        }, () => { handoff.cancelSubmission(request.key); });
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        return;
      }
      if (sendDisabled) return;
      tapHaptic();
      const generation = identityGeneration.current;
      const sourceRect = handoff.captureDraft();
      void act(async () => {
        const fingerprint = submissionFingerprint();
        if (!pendingInput.current) {
          // Navigation is not a source change. Reopened conversations retain their
          // original workspace unless the user explicitly selects another source.
          let sourceForInput = preparedSource;
          if (!active && !delegated && !run && !draft.sourceDisabled && !sourceForInput && workspacePath) {
            const workspace = await api.sources.resolve(identity, { resourceOwner: { kind: 'local' }, path: workspacePath });
            if (generation !== identityGeneration.current || host !== getRuntimeEndpointGeneration()) return;
            sourceForInput = await api.prepareSource({ ...identity, key: crypto.randomUUID(), resourceOwner: workspace.resourceOwner,
              workspaceId: workspace.workspaceId, mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [] });
            if (generation !== identityGeneration.current || host !== getRuntimeEndpointGeneration()) return;
            setPreparedSource(sourceForInput);
          }
          const selections = composerFileSelections(draft.selectedAttachments, referenceScope);
          const files = draft.files ?? [];
          const retained = await prepareThreadFiles(api, identity, draftKey, files);
          const preparedImages = await prepareDraftMarkerImages(draft, api);
          if (generation !== identityGeneration.current || host !== getRuntimeEndpointGeneration()) return;
          const key = crypto.randomUUID();
          const attachments = { attachmentImageReferences: { ...draftAttachmentImageReferences(draft), ...attachmentImageReferences(files, retained).attachmentImageReferences }, ...(materials.length ? { materials: materials.map(({ snapshotId }) => ({ snapshotId })) } : {}),
            ...(retained.length || selections.length ? { attachments: [...retained.map(({ ref }) => ({ ref })), ...selections] } : {}) };
          const quotedFiles = await prepareQuotedFiles({ ...freezeDraftContentReferences(draft), ...attachments }, identity, input => api.attachments.upload(identity, input), api, draft.markerObjects);
          if (generation !== identityGeneration.current || host !== getRuntimeEndpointGeneration()) return;
          const submit = { ...identity, key, text: projectedText, images: preparedImages, ...quotedFiles, ...composerInputReferences(text, draft.references, referenceScope), ...attachments, ...quotedFiles, expectedHead: branch?.head ?? null, model: { providerId, modelId, thinkingLevel, ...(temperature === undefined ? {} : { temperature }) }, ...(!botSurface && !snapshot?.thread.bot_id && !delegated ? { agent } : {}), ...(draft.sourceDisabled ? { source: null } : sourceForInput ? { source: sourceForInput.source } : {}) };
          const queued = { ...identity, key, text: projectedText, images: preparedImages, ...quotedFiles, ...composerInputReferences(text, draft.references, referenceScope), ...attachments, ...quotedFiles, mode: requestedMode };
          const continuation = { ...identity, key, text: projectedText, images: preparedImages, ...quotedFiles, ...composerInputReferences(text, draft.references, referenceScope), ...attachments, ...quotedFiles, previousRunId: run?.id ?? '', expectedHead: branch?.head ?? null };
          if (!active && delegated && (!api.collaboration || !run)) throw new Error('Child continuation is unavailable');
          const goalSettings = useUIStore.getState();
          const goal = !botSurface && draft.goalArmed && !active && !delegated && text.trim() ? { goalObjective: text.trim(),
            ...(goalSettings.sessionGoalDefaultBudgetEnabled ? { goalBudget: goalSettings.sessionGoalDefaultBudget } : {}) } : {};
          pendingInput.current = { fingerprint, editorText: text, editorImages: requestImages, markerObjectIds: draft.markerObjects?.map(object => object.id), markerOccurrenceIds: draft.references?.filter(reference => reference.target.kind === 'quote' || reference.target.kind === 'image').map(reference => reference.id), fileIds: files.map(file => file.id), selectedAttachmentIds: draft.selectedAttachments?.map(file => file.id), editorContext, inlineContext, preparedSource: sourceForInput, ...goal, status: 'sending', ...(active ? { kind: 'enqueue' as const, input: queued }
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
          ...acknowledgeDraftMarkers(current, original.editorText, original.markerObjectIds, original.markerOccurrenceIds, { images: original.editorImages ?? original.input.images, fileIds: original.fileIds, selectedAttachmentIds: original.selectedAttachmentIds }),
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
      {hasDraftInlineImages(draft) && acceptsImages === false && <div className="space-y-1">
        <p role="alert" className="text-sm text-destructive">{t('chat.model.imagesUnsupported')}</p>
        <button type="button" className="text-sm text-primary underline" disabled={pending || Boolean(draft.pendingInput || draft.firstSend)}
          onClick={() => { void convertDraftMarkerImagesToFiles(draftKey, host, api).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }}>{t('chat.model.useImagesAsFiles')}</button>
      </div>}
      {acceptsImages === false && draft.files?.some(file => file.imageReference !== undefined) && <p role="status" className="text-sm text-muted-foreground">{t('chat.model.imagesAsFilesNotice')}</p>}
      <input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label="Choose image attachments"
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
      <input ref={pdfInput} type="file" multiple hidden aria-label={t('chat.attachments.choose')}
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
      {!botSurface && <AutoReviewBanner identity={identity} />}
      {!botSurface && draft.goalArmed && <p className="px-2 typography-meta text-primary">{t('thread.composer.goalArmed')}</p>}
      <ThreadComposer onReferenceSelect={reference => selectComposerFile(draftKey, reference)} attachmentCandidates={[...(draft.files ?? []).map(file => ({ id: file.id, name: file.filename, fileId: file.id })), ...composerHistoryAttachments(visibleHistory).map(attachment => ({ id: attachment.ref, name: attachment.filename, attachment }))]} referenceScope={referenceScope} commandActions={{ ...composerCommands, ...workflows.actions }} onOpenHistory={() => openConversationTree(surface)} identityKey={draftKey} placement={empty ? 'center' : 'bottom'}
        permissionWorkspacePath={active || !preparedSource ? (launch?.selection.source
          // Resource scope is independent of the conversation's presentation.
          ? launch.selection.source.resource_owner.kind === 'local' ? launch.selection.source.live_root?.canonicalRoot : undefined
          : workspacePath) : preparedSource.source.resourceOwner.kind === 'local' ? preparedSource.path : undefined}
        agentControls={!botSurface && !snapshot?.thread.bot_id && !delegated ? <ThreadAgentControls workFocus={workFocus} pending={active} disabled={pending || Boolean(draft.firstSend || draft.pendingInput)}
          onWorkFocusChange={workFocus => useThreadDraftStore.getState().patch(draftKey, { workFocus })} /> : undefined}
        messageHistory={visibleHistory.filter(item => item.source === 'user').slice().reverse().map(item => typeof item.content === 'string' ? item.content : typeof (item.content as { userText?: unknown })?.userText === 'string' ? (item.content as { userText: string }).userText : typeof (item.content as { text?: unknown })?.text === 'string' ? (item.content as { text: string }).text : '')}
        onOpenRecovery={snapshot ? () => showOverview('recovery') : undefined}
        onCompact={branch?.head && !active && providerId && modelId ? async () => { showOverview('context'); await compactThrough(branch.head!); } : undefined}
        editorRef={messageInput} value={text} onChange={(text, references, interactions) => useThreadDraftStore.getState().patch(draftKey, { text, references, interactions })} references={draft.references} interactions={draft.interactions} api={api} identity={identity} source={preparedSource?.source} models={models}
        suggestion={nextStep.text} suggestionError={nextStep.error} onSuggestionDismiss={nextStep.dismiss}
        providerId={providerId} modelId={modelId} thinkingLevel={thinkingLevel} onModelChange={selectModel}
        modelDisabled={pending || Boolean(draft.firstSend) || (delegated && !active)} attachmentDisabled={pending || Boolean(draft.firstSend || draft.pendingInput)}
        imageDisabled={false} sendDisabled={draft.firstSend ? pending : nextStep.text && text.length === 0 && !hasComposerInput ? sendBlocked : sendDisabled} pending={pending} active={active} retrying={Boolean(draft.firstSend || draft.pendingInput)}
        onFiles={files => void addFiles(files)} onAttachImages={() => fileInput.current?.click()} onAttachPdfs={() => pdfInput.current?.click()}
        goalArmed={!botSurface && draft.goalArmed} onGoal={botSurface ? undefined : () => {
          if (active || delegated || snapshot?.goals.some(goal => goal.control !== 'complete' && goal.control !== 'cancelled')) showOverview('goals');
          else if (!draft.pendingInput) useThreadDraftStore.getState().patch(draftKey, { goalArmed: !draft.goalArmed });
        }} onStop={active && branch?.active_run_id ? () => void act(() => api.cancelRun(branch.active_run_id!), true) : undefined}
        imageReferences={draftImageReferences(draft)} attachmentNames={[...images.map(() => ''), ...materials.map(material => material.filename), ...(draft.files ?? []).map(file => file.filename)]}
        hasInput={hasComposerInput}
        prepareSendMode={botSession ? mode => { submitMode.current = mode; } : undefined}
        onWorkspace={botSurface || botSession ? undefined : () => showOverview('sources')} workspaceLabel={preparedSource ? formatDirectoryName(preparedSource.path) : launch?.selection.source?.live_root ? formatDirectoryName(launch.selection.source.live_root.canonicalRoot) : launch?.selection.source ? t('harness.overview.sources') : workspacePath ? formatDirectoryName(workspacePath) : t('thread.composer.chatOnly')}
        workspacePath={localWorkspacePath}
        skills={snapshot?.context.checkpoint?.resources?.snapshot.skills.map(skill => skill.name) ?? []}>
        <div className="space-y-2 px-3 empty:hidden">{!botSurface && emptyWorkspacePath && <ActiveEditorSuggestion threadKey={draftKey} />}      <EditorContextAttachmentChips threadKey={draftKey} /><DraftContentReferences draftKey={draftKey} locked={pending || Boolean(draft.firstSend || draft.pendingInput)} />
      {inlineContext.length > 0 && <div className="flex flex-wrap gap-1" aria-label="Attached context">
        {inlineContext.flatMap(bucket => bucket.drafts.map(item => <Button key={item.id} type="button" size="sm" variant="outline"
          title={item.text || item.fileLabel} onClick={() => useInlineCommentDraftStore.getState().acknowledgeDrafts(bucket.key, [item])}>
          {item.fileLabel} · {item.startLine}–{item.endLine} ×
        </Button>))}
      </div>}
      <ImageAttachmentStrip key={draftKey} images={images} removeLabel={t('chat.fileAttachment.actions.removeImage')}
        onUpdate={pending || draft.pendingInput || draft.firstSend ? undefined : (index,image)=>updateDraftImage(draftKey,index,image)}
        onReference={pending || draft.pendingInput || draft.firstSend ? undefined : insertImageReference}
        onRemove={pending || draft.pendingInput || draft.firstSend ? undefined : index => removeDraftImage(draftKey, index)} />
      <ThreadMaterialAttachments materials={materials} locked={pending || Boolean(draft.firstSend || draft.pendingInput)}
        onRemove={snapshotId => { if (!pendingAction.current && !pendingInput.current) setMaterials(current => current.filter(material => material.snapshotId !== snapshotId)); }} />
      <ComposerSelectedFiles files={draft.selectedAttachments} locked={pending || Boolean(draft.firstSend || draft.pendingInput)} onRemove={id => removeComposerFile(draftKey, id)} />
      <ThreadFileDrafts draftKey={draftKey} onReference={insertImageReference} files={draft.files} locked={pending || Boolean(draft.firstSend || draft.pendingInput)} onRemove={id => removeDraftFile(draftKey, id)} />
        </div>
      </ThreadComposer>
      <div className="chat-input-column flex gap-2">
        {run && pause && <Button type="button" variant="outline" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.resume(run.id, pause.wait_id))}>{t('chat.run.resume')}</Button>}
        {active && run && policyUpdate && policyIncompatible && <Button type="button" variant="outline" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.restartPolicy(identity, run.id, policyUpdate.selection_id))}>Restart strategy state</Button>}
        {active && run && policyUpdate && policyUpdatePending && <Button type="button" variant="ghost" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.cancelPolicyUpdate(identity, run.id, policyUpdate.selection_id))}>Cancel strategy update</Button>}
        {run && launch?.startable && launch.requires_rebind && launch.preparation_failure && !pause && <Button type="button" variant="ghost" disabled={pending} onClick={() => void act(() => api.retryPreparation(run.id))}>{t('chat.run.retryPreparation')}</Button>}
      </div>
    </form>}
    {!botSurface && <Departure present={empty} animated={sendDeparts} exit="sink" stagger=".varin-draft-starters > *" className="conversation-starters"><DraftPresetChips cwd={workspacePath ?? initialWorkspacePath} sessionId={identity.threadId} className="varin-draft-starters"
      onSubmit={starter => {
        if (starter.ref.type === 'command' && starter.ref.name === 'craft-goal') { useThreadDraftStore.getState().patch(draftKey, { goalArmed: true }); messageInput.current?.focus(); return; }
        if (starter.ref.type === 'command' && starter.ref.name === 'schedule-task') { useUIStore.getState().setScheduledTasksDialogOpen(true); return; }
        setText(current => [current.trimEnd(), starter.submitText].filter(Boolean).join('\n\n'));
        messageInput.current?.focus();
      }} /></Departure>}
    </div>}
    {empty && <div className="min-h-6 flex-1" />}
    </div>
    </div>
    {overview}
    {!empty && scrollViewport?.owner === scrollbarOwner && <ConversationScrollbar key={scrollbarOwner} viewport={scrollViewport.element} trackRef={scrollbarTrack} />}
    </div>
  </section></ReferenceNavigationContext.Provider></ThreadMaterials>;
}
