import React from 'react';
import { createExternalAgentsHttpAPI, ExternalAgentError } from '@varin/application-client';
import { useExternalAgents, useExternalAgentStore } from '@/stores/useExternalAgentStore';
import { HarnessSelector } from './HarnessSelector';
import { documentMimeType, DOCUMENT_FILE_ACCEPT } from '@varin/protocol';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, type ThreadModelInfo, type ThreadsAPI, type ThreadThinkingLevel } from '@varin/application-client';
import { ThreadComposer } from './ThreadComposer';
import { ThreadAgentControls } from './ThreadAgentControls';
import { useThreadWorkFocus } from './useThreadWorkFocus';
import { ChatTurnUserMessage } from '../conversation/ChatTimelineEntries';
import { useFirstMessagePreview } from './useFirstMessagePreview';
import { ThreadSourcePicker } from './ThreadSourcePicker';
import { WorkOverviewControl } from './WorkOverviewControl';
import { DraftPresetChips } from '@/components/chat/DraftPresetChips';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { fileToBase64 } from '@/components/chat/composer/fileAttachments';
import { beginImageInsertion, fileToImageAttachment, removeDraftImage } from '@/components/chat/composer/imageAttachments';
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
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { Departure } from '@/components/motion/Departure';
import { tapHaptic } from '@/lib/motion/haptics';

/** Local composition has no execution identity. The first explicit send creates one. */
export function ThreadDraftConversation({ api, draftKey, handoff }: { api: ThreadsAPI; draftKey: string; handoff: MessageHandoff }) {
  const externalSettings = useExternalAgents();
  const [externalBusy, setExternalBusy] = React.useState(false);
  const { t } = useI18n();
  const draft = useThreadDraftStore(state => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const workFocus = useThreadWorkFocus(draftKey, draft.workspacePath);
  const patch = React.useCallback((value: Parameters<ReturnType<typeof useThreadDraftStore.getState>['patch']>[1]) => useThreadDraftStore.getState().patch(draftKey, value), [draftKey]);
  const external = draft.harnessId ? externalSettings?.agents.find(v => v.id === draft.harnessId) : undefined;
  React.useEffect(() => { if (externalSettings && draft.harnessId === undefined && !draft.firstSend) patch({ harnessId: externalSettings.defaultAgent }); }, [externalSettings, draft.harnessId, draft.firstSend, patch]);
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
  const generation = getRuntimeEndpointGeneration();
  const reducedMotion = usePrefersReducedMotion();
  React.useLayoutEffect(() => { handoff.select(String(generation), draftKey, true, reducedMotion); }, [handoff, generation, draftKey, reducedMotion]);
  const mounted = React.useRef(true);
  const currentDraft = React.useRef(draftKey);
  currentDraft.current = draftKey;
  React.useEffect(() => { reading.current = null; setReadingFiles(false); }, [draftKey, generation]);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => {
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
  }, [api, t]);
  const availableThinking = models.find(item => item.providerId === draft.model?.providerId && item.modelId === draft.model?.modelId)?.thinkingLevels;
  const model = draft.model && availableThinking?.length ? { ...draft.model,
    thinkingLevel: draft.model.thinkingLevel && availableThinking.includes(draft.model.thinkingLevel) ? draft.model.thinkingLevel : availableThinking[0],
  } : draft.model;
  React.useEffect(() => {
    if (model?.providerId || model?.modelId) return;
    const controller = new AbortController();
    void createModelConnectionsHttpAPI(generation).readSettings(draft.workspacePath, controller.signal).then(settings => {
      if (controller.signal.aborted || generation !== getRuntimeEndpointGeneration()) return;
      const effective = { ...settings.global, ...(settings.projectTrusted ? settings.project : {}) };
      if (typeof effective.defaultProvider !== 'string' || typeof effective.defaultModel !== 'string') return;
      patch(current => current.model?.providerId || current.model?.modelId ? {} : { model: {
        providerId: effective.defaultProvider as string, modelId: effective.defaultModel as string,
        thinkingLevel: effective.defaultThinkingLevel as ThreadThinkingLevel | undefined,
      } });
    }).catch(cause => { if (!controller.signal.aborted) setModelError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [generation, model?.providerId, model?.modelId, draft.workspacePath, patch, settingsRevision]);
  React.useSyncExternalStore(subscribeEditorContextAttachments, getEditorContextAttachmentsRevision, () => 0);
  const editorContext = listEditorContextAttachments(threadHostKey(), draftKey);
  const buckets = useInlineCommentDraftStore(state => state.drafts);
  const inlineContext = Object.entries(buckets).flatMap(([key, items]) => {
    const drafts = items.filter(item => item.sessionKey === draftKey); return drafts.length ? [{ key, drafts }] : [];
  });
  const inlineDrafts = inlineContext.flatMap(bucket => bucket.drafts);
  const hasInput = Boolean(draft.text.trim() || draft.images.length || draft.pdfs?.length || editorContext.length || inlineDrafts.length);
  const acceptsImages = draft.harnessId ? undefined : models.find(item => item.providerId === model?.providerId && item.modelId === model?.modelId)?.acceptsImages;
  const sending = externalBusy || draft.firstSend?.status === 'sending';
  const locked = externalBusy || Boolean(draft.firstSend) || Boolean(draft.externalInput);
  const sourcePath = draft.sourceSelection?.path ?? draft.workspacePath;
  const changeHarness = (harnessId: string | null) => {
    if (!draft.externalConversationId) { patch({ harnessId }); return; }
    setExternalBusy(true);
    void (async () => {
      const api = createExternalAgentsHttpAPI(generation), original = await api.read(draft.externalConversationId!);
      if (original.turns.length) { await useExternalAgentStore.getState().refresh(); useExternalAgentStore.getState().select(original.conversation.id); return; }
      await api.update(original.conversation.id, original.conversation.revision, { deleted: true });
      patch({ harnessId, externalConversationId: undefined, externalInput: undefined });
      await useExternalAgentStore.getState().refresh();
    })().catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setExternalBusy(false));
  };
  const firstMessage = useFirstMessagePreview(draftKey, false, handoff);
  const addFiles = async (files: File[]) => {
    if (!files.length || reading.current || useThreadDraftStore.getState().drafts[draftKey]?.firstSend) return;
    const token = {};
    const current = () => mounted.current && currentDraft.current === draftKey && generation === getRuntimeEndpointGeneration() && reading.current === token;
    const insertion = beginImageInsertion(draftKey, editor.current, number => t('chat.imageReference.token', { number }));
    reading.current = token; setReadingFiles(true); setError(undefined);
    try {
      for (const file of files) {
        const mimeType = documentMimeType(file.name, file.type);
        if (mimeType) {
          const data = await fileToBase64(file); if (!current()) return;
          patch(value => ({ pdfs: [...(value.pdfs ?? []), { id: crypto.randomUUID(), filename: file.name, data, mimeType }] }));
        } else if (file.type.startsWith('image/')) {
          if (acceptsImages === false) throw new Error(t('chat.model.imagesUnsupported'));
          const image = await fileToImageAttachment(file); if (!current()) return;
          insertion.append(image);
        } else throw new Error(t('chat.fileAttachment.unsupportedType'));
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { insertion.dispose(); if (current()) { reading.current = null; setReadingFiles(false); } }
  };
  const sourceChanged = React.useCallback((sourceSelection: DraftSourceSelection) => patch({ sourceSelection,
    workspacePath: sourceSelection.resourceOwner.kind === 'local' ? sourceSelection.path || undefined : undefined }), [patch]);
  const ignorePrepared = React.useCallback(() => {}, []);
  const sendDisabled = sending || readingFiles || !hasInput || (draft.harnessId ? !external?.enabled : !model?.providerId || !model.modelId) || acceptsImages === false && Boolean(draft.images.length);
  return <section ref={handoff.setRoot} className="regular-chat-view relative flex h-full min-h-0 min-w-0 [container-type:inline-size]" aria-label="Conversation draft">
    <div className="thread-conversation-layout relative flex min-h-0 min-w-0 flex-1">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {firstMessage.message ? <div className="min-h-0 flex-1 overflow-y-auto py-4"><div className="chat-input-column" data-turn-id={`turn:live-user:${firstMessage.message.timestamp}`}>
      <ChatTurnUserMessage cwd={sourcePath ?? ''} message={firstMessage.message} status={firstMessage.status} />
    </div></div> : <div className="min-h-6 flex-1" />}
    <div className="shrink-0 space-y-5 pb-4">
      {/* On send the title rises away and the starters sink, while the composer docks. */}
      <Departure present={!firstMessage.message} exit="rise" startupPart="hero" className="chat-input-column flex flex-col items-center gap-5 pb-1 text-center">
        <VarinLogo width={24} height={24} decorative className="text-muted-foreground" />
        <h1 className="text-2xl font-medium tracking-tight text-foreground md:text-3xl">{sourcePath ? t('chat.emptyState.draftTitleWithProject', { project: formatDirectoryName(sourcePath) }) : t('chat.emptyState.draftTitle')}</h1>
      </Departure>
      <form className="space-y-2" onSubmit={event => {
        event.preventDefault(); if (sendDisabled || reading.current) return;
        if (draft.harnessId) {
          const owner = generation;
          if (draft.pdfs?.length) { setError(t('external.attachments')); return; }
          if (draft.sourceSelection && (draft.sourceSelection.resourceOwner.kind !== 'local' || draft.sourceSelection.mode !== 'live_root')) { setError(t('external.sharedSource')); return; }
          const request = draft.externalInput ?? { key: crypto.randomUUID(), text: projectEditorContextAttachments(appendInlineComments(draft.text, inlineDrafts), editorContext), images: draft.images.map(image => ({ data: image.data, mimeType: image.mimeType })), ...(draft.externalModels?.[draft.harnessId] ? { model: draft.externalModels[draft.harnessId] } : {}) };
          patch({ externalInput: request }); setExternalBusy(true); setError(undefined);
          void (async () => {
            const externalApi = createExternalAgentsHttpAPI(owner);
            const conversation = draft.externalConversationId ? { id: draft.externalConversationId } : await externalApi.create({ key: draftKey, configurationId: draft.harnessId!, ...(sourcePath ? { cwd: sourcePath } : {}), title: request.text.split('\n')[0]?.slice(0, 120) || external?.name || 'Agent' });
            patch({ externalConversationId: conversation.id });
            await externalApi.send(conversation.id, request.key, request);
            await useExternalAgentStore.getState().refresh();
            if (owner === getRuntimeEndpointGeneration()) {
              const current = useThreadDraftStore.getState().drafts[draftKey];
              useThreadDraftStore.getState().patch(`external-draft:${owner}:${conversation.id}`, { externalModels: current?.externalModels,
                ...(current?.text !== draft.text ? { text: current?.text ?? '' } : {}), ...(current?.images !== draft.images ? { images: current?.images ?? [] } : {}) });
              useExternalAgentStore.getState().select(conversation.id); useThreadDraftStore.getState().remove(draftKey);
            }
          })().catch(error => { if (owner === getRuntimeEndpointGeneration()) {
            if (error instanceof ExternalAgentError && error.status >= 400 && error.status < 500 && error.code !== 'host_changed' && error.code !== 'input_changed') patch({ externalInput: undefined });
            setError(error instanceof Error ? error.message : String(error));
          } }).finally(() => { if (mounted.current && owner === getRuntimeEndpointGeneration()) setExternalBusy(false); });
          return;
        }
        const settings = useUIStore.getState();
        const request: ThreadFirstSend = draft.firstSend ?? { key: crypto.randomUUID(), status: 'sending',
          editorText: draft.text, text: projectEditorContextAttachments(appendInlineComments(draft.text, inlineDrafts), editorContext),
          images: draft.images, pdfs: draft.pdfs ?? [], model: model!, agent: { profileId: null, workFocus }, workspacePath: draft.workspacePath, sourceSelection: draft.sourceSelection,
          editorContext, inlineContext,
          ...(draft.goalArmed && draft.text.trim() ? { goalObjective: draft.text.trim(), ...(settings.sessionGoalDefaultBudgetEnabled ? { goalBudget: settings.sessionGoalDefaultBudget } : {}) } : {}),
        };
        tapHaptic();
        handoff.submit(request.key, draftKey, handoff.captureDraft());
        void sendThreadDraft(api, draftKey, request).then(inputId => {
          if (inputId && generation === getRuntimeEndpointGeneration()) handoff.accepted(request.key, inputId);
        }, () => { handoff.cancelSubmission(request.key); });
      }}>
        {(error || modelError || draft.firstSend?.error) && <p role="alert" className="chat-input-column text-sm text-destructive">{error || modelError || draft.firstSend?.error}</p>}
        <input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label="Choose image attachments" onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
        <input ref={pdfInput} type="file" accept={DOCUMENT_FILE_ACCEPT} multiple hidden aria-label={t('chat.fileAttachment.actions.choosePdfs')} onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files); }} />
        {!draft.harnessId && draft.goalArmed && <p className="chat-input-column typography-meta text-primary">{t('thread.composer.goalArmed')}</p>}
        <ThreadComposer editorRef={editor} value={draft.text} onChange={text => patch({ text })} identityKey={draftKey} placement={firstMessage.message ? 'bottom' : 'center'}
          agentControls={<ThreadAgentControls workFocus={workFocus} disabled={locked} onWorkFocusChange={workFocus => patch({ workFocus })} onHarnessChange={changeHarness} />}
          backendControls={draft.harnessId ? <><input aria-label={t('external.model')} className="w-40 min-w-0 bg-transparent px-2 py-1 typography-meta text-muted-foreground placeholder:text-muted-foreground/60 outline-none" placeholder={t('external.inherit')} disabled={locked} value={draft.externalModels?.[draft.harnessId] ?? ''} onChange={event => patch({ externalModels: { ...draft.externalModels, [draft.harnessId!]: event.target.value } })} /><HarnessSelector value={draft.harnessId} disabled={locked} onChange={changeHarness} /></> : undefined}
          models={models} providerId={model?.providerId ?? ''} modelId={model?.modelId ?? ''} thinkingLevel={model?.thinkingLevel ?? 'off'}
          onModelChange={(providerId, modelId, thinkingLevel) => patch({ model: { providerId, modelId, thinkingLevel } })}
          modelDisabled={locked} attachmentDisabled={locked || readingFiles} imageDisabled={acceptsImages === false}
          sendDisabled={sendDisabled} pending={sending} active={false} retrying={locked} hasInput={hasInput}
          delivery={draft.inputMode} onDeliveryChange={inputMode => patch({ inputMode })} allowNextRun
          onFiles={files => void addFiles(files)} onAttachImages={() => fileInput.current?.click()} onAttachPdfs={() => pdfInput.current?.click()}
          onGoal={() => { if (!locked) patch({ goalArmed: !draft.goalArmed }); }} goalArmed={draft.goalArmed}
          onWorkspace={() => setWorkspaceOpen(true)} workspaceLabel={sourcePath ? formatDirectoryName(sourcePath) : t('thread.composer.chatOnly')}
          workspacePath={!draft.sourceSelection || draft.sourceSelection.resourceOwner.kind === 'local' ? sourcePath : undefined}
          attachmentNames={draft.pdfs?.map(item => item.filename) ?? []} skills={[]}>
          <div className="space-y-2 px-3 empty:hidden">
            {sourcePath && <ActiveEditorSuggestion threadKey={draftKey} />}
            <EditorContextAttachmentChips threadKey={draftKey} />
            {inlineDrafts.map(item => <Button key={item.id} type="button" size="sm" variant="outline" disabled={locked}
              onClick={() => { for (const bucket of inlineContext) useInlineCommentDraftStore.getState().acknowledgeDrafts(bucket.key, [item]); }}>{item.fileLabel} · {item.startLine}–{item.endLine} ×</Button>)}
            <ImageAttachmentStrip images={draft.images} removeLabel={t('chat.fileAttachment.actions.removeImage')}
              onReference={locked ? undefined : number => { editor.current?.insertText(t('chat.imageReference.token', { number })); editor.current?.focus(); }}
              onRemove={locked ? undefined : index => removeDraftImage(draftKey, index)} />
            {draft.pdfs?.map(pdf => <Button key={pdf.id} type="button" variant="outline" size="sm" disabled={locked} aria-label={t('chat.fileAttachment.actions.removeNamed', { name: pdf.filename })}
              onClick={() => patch({ pdfs: draft.pdfs?.filter(item => item.id !== pdf.id) })}>{pdf.filename} ×</Button>)}
            {readingFiles && <p role="status">{t('chat.fileAttachment.uploading')}</p>}
          </div>
        </ThreadComposer>
      </form>
      <Departure present={!firstMessage.message && !draft.harnessId} exit="sink" stagger=".varin-draft-starters > *" className="conversation-starters"><DraftPresetChips cwd={sourcePath} className="varin-draft-starters" onSubmit={starter => {
        if (starter.ref.type === 'command' && starter.ref.name === 'craft-goal') patch({ goalArmed: true });
        else if (starter.ref.type === 'command' && starter.ref.name === 'schedule-task') useUIStore.getState().setScheduledTasksDialogOpen(true);
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
        onUseChatOnly={() => patch({ workspacePath: undefined, sourceSelection: undefined, preparedSource: null })} /></div>}
    </WorkOverviewControl>
    </div>
  </section>;
}
