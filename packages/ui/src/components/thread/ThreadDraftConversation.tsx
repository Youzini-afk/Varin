import { prepareQuotedFiles } from '@/lib/agent-runtime/quoteAttachments';
import { freezeDraftContentReferences, insertDraftMarker, acknowledgeDraftMarkers, draftAttachmentImageReferences } from '@/lib/agent-editor/contentReferences';
import { DraftContentReferences } from './DraftContentReferences';
import { draftImageReferences } from '@/lib/images/references';
import { externalAttachmentSupported } from './externalAttachments';
import { selectComposerFile, removeComposerFile } from '@/components/chat/composer/submit/fileSelections';
import { ComposerSelectedFiles } from './ComposerSelectedFiles';
import { composerInputReferences } from '@/components/chat/composer/submit/references';
import React from 'react';
import { createExternalAgentsHttpAPI, ExternalAgentError } from '@varin/application-client';
import { useExternalAgents, useExternalAgentStore } from '@/stores/useExternalAgentStore';
import { useSourceExternalAgents } from '@/hooks/useSourceExternalAgents';
import { HarnessSelector } from './HarnessSelector';
import { ExternalConnectionStatus } from './ExternalConnectionStatus';
import { externalSessionInput, normalizeExternalSessionChoice, type ExternalSessionChoice } from './externalSessionChoice';
import { useExternalDraftPreparation } from './useExternalDraftPreparation';
import { createModelConnectionsHttpAPI, defaultConversationModel, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ThreadModelInfo, type ThreadsAPI } from '@varin/application-client';
import { ThreadComposer } from './ThreadComposer';
import { ThreadAgentControls } from './ThreadAgentControls';
import { useThreadWorkFocus } from './useThreadWorkFocus';
import { ChatTurnUserMessage } from '../conversation/ChatTimelineEntries';
import { useFirstMessagePreview } from './useFirstMessagePreview';
import { ThreadSourcePicker } from './ThreadSourcePicker';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { projectModelSettingsId } from '@/lib/projectResolution';
import { WorkOverviewControl } from './WorkOverviewControl';
import { DraftPresetChips } from '@/components/chat/DraftPresetChips';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { removeDraftFile, attachmentImageReferences, selectThreadFiles, prepareDraftFiles } from '@/lib/agent-runtime/fileAttachments';
import { ThreadFileDrafts } from './ThreadAttachments';
import { removeDraftImage, updateDraftImage } from '@/components/chat/composer/imageAttachments';
import { prepareDraftMarkerImages, hasDraftInlineImages, convertDraftMarkerImagesToFiles } from '@/lib/agent-runtime/draftImages';
import { ActiveEditorSuggestion } from '@/components/conversation/ActiveEditorSuggestion';
import { EditorContextAttachmentChips } from '@/components/workbench/EditorContextAttachmentChips';
import { getEditorContextAttachmentsRevision, listEditorContextAttachments, subscribeEditorContextAttachments } from '@/lib/agent-editor/attachments';
import { projectEditorContextAttachments } from '@/lib/agent-editor/projection';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { sendThreadDraft } from '@/lib/agent-runtime/sendThreadDraft';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { threadHostKey } from '@/stores/useThreadStore';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore, type DraftSourceSelection, type ThreadFirstSend } from '@/stores/useThreadDraftStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { formatDirectoryName } from '@/lib/utils';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { Button } from '@/components/ui/button';
import type { MessageHandoff } from '@/components/conversation/messageHandoff';
import { useConversationBot } from '@/hooks/useConversationBot';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { Departure } from '@/components/motion/Departure';
import { tapHaptic } from '@/lib/motion/haptics';

/** Native composition stays local until send; external preparation binds a session without model input. */
export function ThreadDraftConversation({ api, draftKey, handoff }: { api: ThreadsAPI; draftKey: string; handoff: MessageHandoff }) {
  const localExternalSettings = useExternalAgents();
  const [externalBusy, setExternalBusy] = React.useState(false);
  const externalSending = React.useRef(false);
  const [externalFailure, setExternalFailure] = React.useState<unknown>();
  const { t } = useI18n();
  const snapshotPublisher = React.useRef({}).current;
  const draft = useThreadDraftStore(state => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const conversationBot = useConversationBot(draft.botId);
  const sourceOwner = draft.sourceSelection?.resourceOwner;
  const sourceOwnerKey = JSON.stringify(sourceOwner ?? { kind: 'local' });
  const sourceRemote = Boolean(sourceOwner && sourceOwner.kind !== 'local');
  const [agentSelectorOpened, setAgentSelectorOpened] = React.useState(false);
  const sourceAgents = useSourceExternalAgents(sourceOwner, sourceRemote && (Boolean(draft.harnessId) || agentSelectorOpened));
  const externalSettings = sourceRemote ? sourceAgents.settings : localExternalSettings;
  const harnessSelector = { settings: externalSettings, sourceRemote, loading: sourceRemote && sourceAgents.loading,
    error: sourceRemote ? sourceAgents.error : undefined, onRetry: sourceAgents.retry,
    onOpenChange: (open: boolean) => { if (open) { if (agentSelectorOpened) sourceAgents.retry(); else setAgentSelectorOpened(true); } } };
  const externalChoiceKey = draft.harnessId ? sourceRemote ? JSON.stringify([sourceOwnerKey, draft.harnessId]) : draft.harnessId : '';
  const workFocus = useThreadWorkFocus(draftKey, draft.workspacePath);
  const patch = React.useCallback((value: Parameters<ReturnType<typeof useThreadDraftStore.getState>['patch']>[1]) => useThreadDraftStore.getState().patch(draftKey, value), [draftKey]);
  const external = draft.harnessId ? externalSettings?.agents.find(v => v.id === draft.harnessId) : undefined;
  React.useEffect(() => { if (!draft.botId && externalSettings && draft.harnessId === undefined && !draft.firstSend) patch({ harnessId: externalSettings.defaultAgent }); }, [externalSettings, draft.botId, draft.harnessId, draft.firstSend, patch]);
  React.useEffect(() => {
    if (!draft.botId || !conversationBot.bot) return;
    const bot = conversationBot.bot;
    patch(current => ({
      ...(!current.model && bot.model ? { model: bot.model } : {}),
      ...(!current.sourceDisabled && !current.sourceSelection && !current.workspacePath && !current.firstSend ? { sourceSelection: {
        resourceOwner: { kind: 'local' as const }, path: bot.homeDir, mode: 'live_root' as const,
        contentMode: 'saved-files' as const, captureScopes: [],
      } } : {}),
      ...(current.harnessId !== null ? { harnessId: null } : {}),
    }));
  }, [draft.botId, conversationBot.bot, patch]);
  const [models, setModels] = React.useState<ThreadModelInfo[]>([]);
  const [error, setError] = React.useState<string>();
  const [modelError, setModelError] = React.useState<string>();
  const [settingsRevision, refreshSettings] = React.useReducer(value => value + 1, 0);
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const editor = React.useRef<ComposerEditorHandle | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const pdfInput = React.useRef<HTMLInputElement>(null);
  const reading = React.useRef<object | null>(null);
  const [readingFiles, setReadingFiles] = React.useState(false);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const sourcePath = draft.sourceSelection?.path ?? draft.workspacePath;
  const referenceScope = JSON.stringify([generation, draftKey, draft.sourceSelection ?? draft.workspacePath]);
  const preparation = useExternalDraftPreparation({ draftKey, host: generation, configurationId: draft.harnessId, cwd: sourcePath, name: external?.name });
  const capabilities = preparation.snapshot?.capabilities ?? (draft.harnessId ? externalSettings?.capabilityCache?.[draft.harnessId]?.capabilities : undefined);
  const capabilitiesSource = preparation.snapshot?.capabilities ? preparation.snapshot.capabilitiesSource ?? (preparation.snapshot.connected ? 'live' : 'cached') : capabilities ? 'cached' : undefined;
  const backendIdentity = draft.harnessId ? JSON.stringify(sourceRemote ? [draft.harnessId, draftKey, sourceOwnerKey, sourcePath] : [draft.harnessId, draftKey, sourcePath]) : undefined;
  const externalChoice: ExternalSessionChoice = draft.harnessId ? { model: draft.externalModels?.[externalChoiceKey] ?? external?.defaults?.model ?? '', ...(draft.externalOptions?.[externalChoiceKey] ?? { thinking: external?.defaults?.thinking, mode: external?.defaults?.mode }) } : {};
  const changeExternalChoice = (choice: ExternalSessionChoice) => {
    if (!draft.harnessId) return;
    patch({ externalModels: { ...draft.externalModels, [externalChoiceKey]: choice.model ?? '' },
      externalOptions: { ...draft.externalOptions, [externalChoiceKey]: { thinking: choice.thinking, mode: choice.mode, config: choice.config } } });
  };
  React.useEffect(() => {
    if (!external || Object.prototype.hasOwnProperty.call(draft.externalModels ?? {}, externalChoiceKey)) return;
    patch(current => ({ externalModels: { ...current.externalModels, [externalChoiceKey]: external.defaults?.model ?? '' },
      externalOptions: { ...current.externalOptions, [externalChoiceKey]: { thinking: external.defaults?.thinking, mode: external.defaults?.mode } } }));
  }, [external, externalChoiceKey, draft.externalModels, patch]);
  const [interactionScope, setInteractionScope] = React.useState<string>();
  const connectionScope = JSON.stringify([generation, draftKey, draft.harnessId, sourceOwnerKey, sourcePath]);
  const prepare = (force: boolean | 'models' = false) => {
    if (!draft.harnessId || !external?.enabled || !sourcePath) return Promise.resolve(undefined);
    if (draft.sourceSelection && (draft.sourceSelection.mode !== 'live_root')) { setError(t('external.sharedSource')); return Promise.resolve(undefined); }
    setExternalFailure(undefined);
    return preparation.prepare(force);
  };
  const prepareRef = React.useRef(prepare); prepareRef.current = prepare;
  // This marker is set only by a selector action, never by opening/restoring a draft.
  React.useEffect(() => {
    if (interactionScope !== connectionScope) return;
    setInteractionScope(undefined); void prepareRef.current().catch(() => {});
  }, [interactionScope, connectionScope]);
  React.useEffect(() => { if (preparation.snapshot) useExternalAgentStore.getState().setSnapshot(preparation.snapshot, generation, snapshotPublisher); }, [preparation.snapshot, generation, snapshotPublisher]);
  const preparedId = preparation.snapshot?.conversation.id;
  React.useEffect(() => () => { if (preparedId) useExternalAgentStore.getState().clearSnapshot(preparedId, generation, snapshotPublisher); }, [preparedId, generation, snapshotPublisher]);
  const preparationHasWork = preparation.snapshot?.turns.some(turn => ['queued', 'preparing', 'running', 'waiting_user', 'stopping'].includes(turn.status)) ?? false;
  const preparationFailure = externalFailure ?? preparation.error ?? (sourceRemote ? sourceAgents.error : undefined);
  const reducedMotion = usePrefersReducedMotion();
  React.useLayoutEffect(() => { handoff.select(String(generation), draftKey, true, reducedMotion); }, [handoff, generation, draftKey, reducedMotion]);
  const mounted = React.useRef(true);
  const currentDraft = React.useRef(draftKey);
  currentDraft.current = draftKey;
  React.useEffect(() => { reading.current = null; setReadingFiles(false); externalSending.current = false; setExternalBusy(false); setExternalFailure(undefined); setError(undefined); }, [draftKey, generation]);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => {
    if (draft.harnessId) return;
    let active = true; let request = 0;
    const refresh = () => {
      const id = ++request;
      void api.listModels().then(value => { if (active && id === request) { setModels(value); setModelError(undefined); } },
        () => { if (active && id === request) setModelError(t('settings.agents.modelsUnavailable')); });
    };
    refresh();
    const unsubscribe = subscribeVarinEvents(event => {
      if (event.type === 'stream-ready' || event.type === 'settings-changed' && event.owner === 'agent-settings') { refresh(); refreshSettings(); }
    });
    return () => { active = false; unsubscribe(); };
  }, [api, draft.harnessId, t]);
  const availableThinking = models.find(item => item.providerId === draft.model?.providerId && item.modelId === draft.model?.modelId)?.thinkingLevels;
  const model = draft.model && availableThinking?.length ? { ...draft.model,
    thinkingLevel: draft.model.thinkingLevel && availableThinking.includes(draft.model.thinkingLevel) ? draft.model.thinkingLevel : availableThinking[0],
  } : draft.model;
  React.useEffect(() => {
    if (draft.harnessId || model?.providerId || model?.modelId || draft.botId && conversationBot.loading) return;
    const controller = new AbortController();
    void createModelConnectionsHttpAPI(generation).readSettings(draft.workspacePath, controller.signal, projectModelSettingsId(useProjectsStore.getState().projects, draft.projectId, draft.sourceSelection)).then(settings => {
      if (controller.signal.aborted || generation !== getRuntimeEndpointGeneration()) return;
      const effective = { ...settings.global, ...(settings.projectTrusted ? settings.project : {}) };
      const selection = defaultConversationModel(effective, models);
      if (selection) patch(current => current.model?.providerId || current.model?.modelId ? {} : { model: selection });
    }).catch(cause => { if (!controller.signal.aborted) setModelError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [generation, draft.harnessId, draft.botId, conversationBot.loading, model?.providerId, model?.modelId, draft.workspacePath, draft.projectId, draft.sourceSelection, patch, settingsRevision, models]);
  React.useSyncExternalStore(subscribeEditorContextAttachments, getEditorContextAttachmentsRevision, () => 0);
  const editorContext = listEditorContextAttachments(threadHostKey(), draftKey);
  const buckets = useInlineCommentDraftStore(state => state.drafts);
  const inlineContext = Object.entries(buckets).flatMap(([key, items]) => {
    const drafts = items.filter(item => item.sessionKey === draftKey); return drafts.length ? [{ key, drafts }] : [];
  });
  const inlineDrafts = inlineContext.flatMap(bucket => bucket.drafts);
  const hasInput = Boolean(draft.text.trim() || draft.images.length || draft.files?.length || draft.selectedAttachments?.length || editorContext.length || inlineDrafts.length || draft.markerObjects?.length);
  const acceptsImages = draft.harnessId ? capabilities?.images : models.find(item => item.providerId === model?.providerId && item.modelId === model?.modelId)?.acceptsImages;
  const sending = externalBusy || draft.firstSend?.status === 'sending';
  const locked = externalBusy || Boolean(draft.firstSend) || Boolean(draft.externalInput);
  const changeHarness = (harnessId: string | null) => {
    if (harnessId === draft.harnessId || externalSending.current) return;
    setError(undefined); setExternalFailure(undefined);
    void preparation.change({ harnessId }).then(changed => {
      if (changed && harnessId) setInteractionScope(JSON.stringify([generation, draftKey, harnessId, sourceOwnerKey, sourcePath]));
    });
  };
  const firstMessage = useFirstMessagePreview(draftKey, false, handoff);
  const insertImageReference = (number: number) => {
    const object = useThreadDraftStore.getState().drafts[draftKey]?.markerObjects?.find(object => object.kind === 'image' && object.number === number);
    if (object) void insertDraftMarker(draftKey, object);
  };
  const addFiles = async (files: File[]) => {
    const latest = useThreadDraftStore.getState().drafts[draftKey];
    if (!files.length || reading.current || latest?.firstSend || latest?.externalInput || externalSending.current) return;
    if (draft.harnessId && files.some(file => !externalAttachmentSupported(capabilities, file))) { setError(t(capabilities ? 'external.filesUnsupported' : 'external.capabilitiesUnknown')); return; }
    const token = {};
    const current = () => mounted.current && currentDraft.current === draftKey && generation === getRuntimeEndpointGeneration() && reading.current === token;
    reading.current = token; setReadingFiles(true); setError(undefined);
    try {
      for (const file of files) {
        if (!current()) return;
        selectThreadFiles(draftKey, [file]);
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current()) { reading.current = null; setReadingFiles(false); } }
  };
  const sourceChanged = (sourceSelection: DraftSourceSelection) => {
    if (externalSending.current) return;
    void preparation.change({ sourceSelection, projectId: undefined, sourceDisabled: false, workspacePath: sourceSelection.resourceOwner.kind === 'local' ? sourceSelection.path || undefined : undefined });
  };
  const ignorePrepared = React.useCallback(() => {}, []);
  const unsupportedReferences = Boolean(draft.harnessId && (draft.selectedAttachments?.length || draft.references?.some(reference => reference.target.kind !== 'draft-file' && reference.target.kind !== 'quote' && reference.target.kind !== 'image' && !(reference.target.kind === 'backend-command' && reference.target.backend === backendIdentity) && draft.text.slice(reference.from, reference.to) === reference.text)));
  const sendDisabled = Boolean(draft.botId && (conversationBot.loading || !conversationBot.bot || conversationBot.bot.archived || conversationBot.bot.deletion)) || sending || readingFiles || unsupportedReferences || !hasInput || (draft.harnessId ? !external?.enabled || !sourcePath : !model?.providerId || !model.modelId) || acceptsImages === false && hasDraftInlineImages(draft);
  return <section ref={handoff.setRoot} className="regular-chat-view relative flex h-full min-h-0 min-w-0 [container-type:inline-size]" aria-label="Conversation draft">
    <div className="thread-conversation-layout relative flex min-h-0 min-w-0 flex-1">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {firstMessage.message ? <div className="min-h-0 flex-1 overflow-y-auto py-4"><div className="chat-input-column" data-turn-id={`turn:live-user:${firstMessage.message.timestamp}`}>
      <ChatTurnUserMessage cwd={sourcePath ?? ''} message={firstMessage.message} status={firstMessage.status} />
    </div></div> : <div className="min-h-6 flex-1" />}
    <div className="shrink-0 space-y-5 pb-4">
      {/* On send the title rises away and the starters sink, while the composer docks. */}
      <Departure present={!firstMessage.message} exit="rise" startupPart="hero" className="chat-input-column flex flex-col items-center gap-5 pb-1 text-center">
        <>{conversationBot.bot ? <BotFigure bot={conversationBot.bot} state="idle" size={48} /> : <VarinLogo width={24} height={24} decorative className="text-muted-foreground" />}</>
        <h1 className="text-2xl font-medium tracking-tight text-foreground md:text-3xl">{conversationBot.bot ? t('bot.hero.title', { name: conversationBot.bot.name }) : sourcePath ? t('chat.emptyState.draftTitleWithProject', { project: formatDirectoryName(sourcePath) }) : t('chat.emptyState.draftTitle')}</h1>
      </Departure>
      {conversationBot.error && <p role="alert" className="chat-input-column text-sm text-destructive">{conversationBot.error}</p>}
      <form className="space-y-2" onSubmit={event => {
        event.preventDefault(); if (sendDisabled || reading.current || externalSending.current) return;
        if (draft.harnessId) {
          if (unsupportedReferences) { setError(t('composer.references.external')); return; }
          const owner = generation;
          const current = () => mounted.current && currentDraft.current === draftKey && owner === getRuntimeEndpointGeneration();
          if (draft.sourceSelection && (draft.sourceSelection.mode !== 'live_root')) { setError(t('external.sharedSource')); return; }
          externalSending.current = true; setExternalBusy(true); setError(undefined); setExternalFailure(undefined);
          void (async () => {
            const externalApi = createExternalAgentsHttpAPI(owner);
            const ready = await prepare();
            if (!ready || !current()) return;
            if (!ready.connected || !ready.capabilities || ready.capabilitiesSource === 'cached' || ready.conversation.needsReview) throw new Error(t(ready.conversation.needsReview ? 'external.review' : 'external.prepareHint'));
            const conversation = ready.conversation;
            if (hasDraftInlineImages(draft) && !ready.capabilities.images) throw new Error(t('external.imagesUnsupported'));
            if (draft.files?.some(file => !externalAttachmentSupported(ready.capabilities, file))) throw new Error(t('external.filesUnsupported'));
            const attachments = draft.externalInput ? [] : await prepareDraftFiles(draftKey, draft.files ?? [], `external:${conversation.id}`,
              (file, signal) => externalApi.uploadAttachment(conversation.id, { key: file.uploadKey ?? file.id, filename: file.filename, mimeType: file.mimeType, data: file.data }, signal));
            if (!current()) return;
            const quotedFiles = draft.externalInput ? {} : await prepareQuotedFiles({ ...freezeDraftContentReferences(draft), attachments: attachments.map(({ ref }) => ({ ref })), attachmentImageReferences: { ...draftAttachmentImageReferences(draft), ...attachmentImageReferences(draft.files ?? [], attachments).attachmentImageReferences } }, undefined, input => externalApi.uploadAttachment(conversation.id, input), api, draft.markerObjects);
            if (!current()) return;
            const request = draft.externalInput ?? { key: crypto.randomUUID(), text: projectEditorContextAttachments(appendInlineComments(draft.text, inlineDrafts), editorContext), ...quotedFiles,
              images: (await prepareDraftMarkerImages(draft, api)).map(image => ({ data: image.data, mimeType: image.mimeType, reference: image.reference })), ...externalSessionInput(normalizeExternalSessionChoice(externalChoice, ready.capabilities), ready.capabilities) };
            if (!current()) return;
            const captured = draft.externalInputSnapshot ?? { editorText: draft.text, markerObjectIds: draft.markerObjects?.map(object => object.id), markerOccurrenceIds: draft.references?.map(reference => reference.id), images: draft.images, fileIds: draft.files?.map(file => file.id) };
            patch({ externalInput: request, externalInputSnapshot: captured });
            await externalApi.send(conversation.id, request.key, request);
            if (!current()) return;
            await useExternalAgentStore.getState().refresh();
            if (current()) {
              const current = useThreadDraftStore.getState().drafts[draftKey];
              useThreadDraftStore.getState().patch(`external-draft:${owner}:${conversation.id}`, { externalModels: { ...current?.externalModels, [draft.harnessId!]: externalChoice.model ?? '' }, externalOptions: { ...current?.externalOptions, [draft.harnessId!]: { thinking: externalChoice.thinking, mode: externalChoice.mode, config: externalChoice.config } },
                ...(current ? acknowledgeDraftMarkers(current, captured.editorText, captured.markerObjectIds, captured.markerOccurrenceIds, captured) : {}) });
              useExternalAgentStore.getState().select(conversation.id); useThreadDraftStore.getState().remove(draftKey);
            }
          })().catch(error => { if (current()) {
            if (error instanceof ExternalAgentError && error.status >= 400 && error.status < 500 && error.code !== 'host_changed' && error.code !== 'input_changed') patch({ externalInput: undefined, externalInputSnapshot: undefined });
            setExternalFailure(error);
          } }).finally(() => { if (current()) { externalSending.current = false; setExternalBusy(false); } });
          return;
        }
        try {
        const settings = useUIStore.getState();
        const request: ThreadFirstSend = draft.firstSend ?? { key: crypto.randomUUID(), status: 'sending',
          ...composerInputReferences(draft.text, draft.references, referenceScope), editorText: draft.text, text: projectEditorContextAttachments(appendInlineComments(draft.text, inlineDrafts), editorContext), ...freezeDraftContentReferences(draft),
          images: draft.images, imageObjects: draft.markerObjects, files: draft.files ?? [], selectedAttachments: draft.selectedAttachments, referenceScope, model: model!, ...(!draft.botId ? { agent: { profileId: null, workFocus } } : {}), workspacePath: draft.workspacePath, sourceSelection: draft.sourceSelection, sourceDisabled: draft.sourceDisabled,
          attachmentImageReferences: draftAttachmentImageReferences(draft), editorContext, inlineContext, markerObjectIds: draft.markerObjects?.map(object => object.id), markerOccurrenceIds: draft.references?.filter(reference => reference.target.kind === 'quote' || reference.target.kind === 'image').map(reference => reference.id),
          ...(draft.goalArmed && draft.text.trim() ? { goalObjective: draft.text.trim(), ...(settings.sessionGoalDefaultBudgetEnabled ? { goalBudget: settings.sessionGoalDefaultBudget } : {}) } : {}),
        };
        tapHaptic();
        handoff.submit(request.key, draftKey, handoff.captureDraft());
        void sendThreadDraft(api, draftKey, request).then(inputId => {
          if (inputId && generation === getRuntimeEndpointGeneration()) handoff.accepted(request.key, inputId);
        }, () => { handoff.cancelSubmission(request.key); });
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>
        {(error || (!draft.harnessId && modelError) || draft.firstSend?.error || draft.sendError) && <p role="alert" className="chat-input-column text-sm text-destructive">{error || (!draft.harnessId && modelError) || draft.firstSend?.error || draft.sendError}</p>}
        {unsupportedReferences && <p role="alert" className="chat-input-column text-sm text-destructive">{t('composer.references.external')}</p>}
        {!draft.harnessId && hasDraftInlineImages(draft) && acceptsImages === false && <div className="chat-input-column space-y-1">
          <p role="alert" className="text-sm text-destructive">{t('chat.model.imagesUnsupported')}</p>
          <button type="button" className="text-sm text-primary underline" disabled={locked}
            onClick={() => { void convertDraftMarkerImagesToFiles(draftKey, generation, api).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }}>{t('chat.model.useImagesAsFiles')}</button>
        </div>}
        {!draft.harnessId && acceptsImages === false && draft.files?.some(file => file.imageReference !== undefined) && <p role="status" className="chat-input-column text-sm text-muted-foreground">{t('chat.model.imagesAsFilesNotice')}</p>}
        {draft.harnessId && <div className="chat-input-column space-y-3">
          {Boolean(preparation.snapshot?.turns.length) && <Button type="button" variant="outline" disabled={sending} onClick={() => {
            const id = preparation.snapshot!.conversation.id;
            void useExternalAgentStore.getState().refresh().then(() => {
              if (mounted.current && currentDraft.current === draftKey && generation === getRuntimeEndpointGeneration()) useExternalAgentStore.getState().select(id);
            }).catch(cause => { if (generation === getRuntimeEndpointGeneration()) setError(String(cause)); });
          }}>{t('external.openPrepared')}</Button>}

        </div>}
        <input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label="Choose image attachments" onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
        <input ref={pdfInput} type="file" multiple hidden aria-label={t('chat.attachments.choose')} onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
        {!draft.harnessId && draft.goalArmed && <p className="chat-input-column typography-meta text-primary">{t('thread.composer.goalArmed')}</p>}
        <ThreadComposer backendIdentity={backendIdentity} onReferenceSelect={reference => selectComposerFile(draftKey, reference)} attachmentCandidates={(draft.files ?? []).map(file => ({ id: file.id, name: file.filename, fileId: file.id }))} pendingSource={draft.sourceSelection ? { resourceOwner: draft.sourceSelection.resourceOwner, path: draft.sourceSelection.path } : sourcePath ? { resourceOwner: { kind: 'local' }, path: sourcePath } : undefined} referenceScope={referenceScope} editorRef={editor} value={draft.text} onChange={(text, references) => patch({ text, references })} references={draft.references} api={api} identityKey={draftKey} placement={firstMessage.message ? 'bottom' : 'center'}
          agentControls={!draft.botId ? <ThreadAgentControls harnessSelector={harnessSelector} workFocus={workFocus} disabled={locked} onWorkFocusChange={workFocus => patch({ workFocus })} onHarnessChange={changeHarness} /> : undefined}
          external={draft.harnessId ? { capabilities, source: capabilitiesSource, choice: externalChoice, disabled: locked, retryDisabled: preparationHasWork, retryDisabledReason: preparation.snapshot?.connected && capabilities?.resume === false && !capabilities.modelsRefresh ? t('external.reconnectUnsupported') : undefined, onChange: changeExternalChoice,
            onInteract: kind => { if (kind !== 'input' || !preparationFailure) void prepare().catch(() => {}); }, onRetryModels: () => { void prepare(capabilities?.modelsRefresh ? 'models' : true).catch(() => {}); } } : undefined}
          connectionStatus={draft.harnessId ? <ExternalConnectionStatus snapshot={preparation.snapshot} name={external?.name} cwd={sourcePath}
            busy={preparation.busy} cancelling={preparation.cancelling} error={preparationFailure} reconnectDisabled={!external?.enabled || !sourcePath || externalBusy || preparationHasWork || Boolean(draft.externalInput)}
            onReconnect={() => { void prepare(true).catch(() => {}); }} onCancel={() => { void preparation.cancel(); }}
            onAuthenticate={methodId => { setExternalFailure(undefined); void preparation.authenticate(methodId).catch(() => {}); }} /> : undefined}
          backendCommands={capabilities?.commands}
          backendControls={draft.harnessId ? <HarnessSelector {...harnessSelector} value={draft.harnessId} disabled={locked} onChange={changeHarness} /> : undefined}
          models={models} providerId={model?.providerId ?? ''} modelId={model?.modelId ?? ''} thinkingLevel={model?.thinkingLevel ?? 'off'}
          onModelChange={(providerId, modelId, thinkingLevel) => patch({ model: { providerId, modelId, thinkingLevel } })}
          modelDisabled={locked} attachmentDisabled={locked || readingFiles} imageDisabled={draft.harnessId ? !capabilities?.images : acceptsImages === false}
          sendDisabled={sendDisabled} pending={sending} active={false} retrying={locked} hasInput={hasInput}
          onFiles={files => void addFiles(files)} onAttachImages={() => fileInput.current?.click()} onAttachPdfs={() => pdfInput.current?.click()}
          onGoal={() => { if (!locked) patch({ goalArmed: !draft.goalArmed }); }} goalArmed={draft.goalArmed}
          onWorkspace={draft.botId ? undefined : () => setWorkspaceOpen(true)} workspaceLabel={sourcePath ? formatDirectoryName(sourcePath) : t('thread.composer.chatOnly')}
          workspacePath={!draft.sourceSelection || draft.sourceSelection.resourceOwner.kind === 'local' ? sourcePath : undefined}
          imageReferences={draftImageReferences(draft)} attachmentNames={draft.files?.map(item => item.filename) ?? []} skills={[]}>
          <div className="space-y-2 px-3 empty:hidden">
            {sourcePath && <ActiveEditorSuggestion threadKey={draftKey} />}
            <EditorContextAttachmentChips threadKey={draftKey} /><DraftContentReferences draftKey={draftKey} locked={locked} />
            {inlineDrafts.map(item => <Button key={item.id} type="button" size="sm" variant="outline" disabled={locked}
              onClick={() => { for (const bucket of inlineContext) useInlineCommentDraftStore.getState().acknowledgeDrafts(bucket.key, [item]); }}>{item.fileLabel} · {item.startLine}–{item.endLine} ×</Button>)}
            <ImageAttachmentStrip key={draftKey} images={draft.images} removeLabel={t('chat.fileAttachment.actions.removeImage')}
              onUpdate={locked ? undefined : (index,image)=>updateDraftImage(draftKey,index,image)}
              onReference={locked ? undefined : insertImageReference}
              onRemove={locked ? undefined : index => removeDraftImage(draftKey, index)} />
            <ComposerSelectedFiles files={draft.selectedAttachments} locked={sending} onRemove={id => removeComposerFile(draftKey, id)} />
          <ThreadFileDrafts draftKey={draftKey} onReference={insertImageReference} files={draft.files} locked={locked} onRemove={id => removeDraftFile(draftKey, id)} />
            {readingFiles && <p role="status">{t('chat.fileAttachment.uploading')}</p>}
          </div>
        </ThreadComposer>
      </form>
      <Departure present={!firstMessage.message && !draft.harnessId} exit="sink" stagger=".varin-draft-starters > *" className="conversation-starters"><DraftPresetChips cwd={sourcePath} className="varin-draft-starters" onSubmit={starter => {
        if (starter.ref.type === 'command' && starter.ref.name === 'craft-goal') patch({ goalArmed: true });
        else if (starter.ref.type === 'command' && starter.ref.name === 'schedule-task') useUIStore.getState().setScheduledTasksDialogOpen(true, { model });
        else patch(current => ({ text: [current.text.trimEnd(), starter.submitText].filter(Boolean).join('\n\n') }));
        editor.current?.focus();
      }} /></Departure>
    </div>
    {!firstMessage.message && <div className="min-h-6 flex-1" />}
    </div>
    <WorkOverviewControl open={workspaceOpen} compactOpen={false} rows={[]} attention={false}
      onOpenChange={setWorkspaceOpen} onCompactChange={() => {}} onSelect={() => {}}>
      {workspaceOpen && <div className="min-h-0 overflow-y-auto"><ThreadSourcePicker api={api} identity={null} initialPath={draft.workspacePath} draftSelection={draft.sourceSelection}
        onDraftSelection={sourceChanged} active={locked} launch={null} prepared={null} onPrepared={ignorePrepared} onPreparingChange={ignorePrepared}
        onUseChatOnly={() => { if (!externalSending.current) void preparation.change({ workspacePath: undefined, projectId: undefined, sourceSelection: undefined, sourceDisabled: true, preparedSource: null }); }} /></div>}
    </WorkOverviewControl>
    </div>
  </section>;
}
