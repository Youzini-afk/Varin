import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { resolveCompanionAccentPalette } from '@/components/companion/companionAccentPalette';
import { showCompanionAttentionSummary } from '@/components/companion/attentionPresentation';
import { useCompanionAssociation } from '@/components/companion/useCompanionAssociation';
import { companionDirectorMode } from '@/components/companion/directorMode';
import { createDirectorReviewFixtureSession, type DirectorReviewStep } from '@/components/companion/directorReviewFixtures';
import { useCompanionDirector } from '@/components/companion/useCompanionDirector';
import { useDirectorPortfolio } from '@/components/companion/useDirectorPortfolio';
import { directorToolDetail } from '@/components/companion/directorPortfolio';
import { companionLocalIdle, companionClosedDrawing, companionClosedSequence, companionSafeOpenDrawing, directorLocalResponse } from '@/components/companion/directorLocalInteraction';
import { directorBodyAction, directorStopRecoveryReady } from '@/components/companion/directorBody';
import { useCompanionAttention } from '@/components/companion/useCompanionAttention';
import { useCompanionVisualIntent } from '@/components/companion/useCompanionVisualIntent';
import { CompanionAttentionPanel, CompanionAttentionSummary } from '@/components/companion/CompanionAttentionPanel';
import { CompanionChildTeam, hasCurrentChildWork } from '@/components/companion/childTeam';
import { COMPANION_QUIET_ACTIONS, useCompanionLeisure } from '@/components/companion/useCompanionLeisure';
import { CompanionProgressFacts, withCompanionProgress, type CompanionProgress } from '@/components/companion/progressPresentation';
import { sceneCue } from '@/components/companion/sceneCues';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type DesktopCompanionDrawing, type RuntimeAPIs, type ThreadIdentity, type ThreadSnapshot, type ThreadSummary } from '@varin/application-client';
import { ThreadProjection } from '@/lib/agent-runtime/thread-projection';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { readCompanionPackage, readCompanionEndpoints, type CompanionEndpoints, type CompanionPackage } from '@/components/companion/sequencePackage';
import { useCompanionWindow } from '@/components/companion/useCompanionWindow';
import { useCompanionPlayback } from '@/components/companion/useCompanionPlayback';
import { route, type PlaybackAsset } from '@/components/companion/playback.mjs';
import { CompanionAccentMaterial } from '@/components/companion/companionAccentMaterial';
import { paintCompanionFrame } from '@/components/companion/paintCompanionFrame';
import { pickupPreloadDependencies } from '@/components/companion/pickupPreload';
import { projectCompanionIntent, newlyAnsweredQuestion, companionObserverAction, companionReceipt, currentCompanionReceipt, consumeCompanionReceipt, type CompanionReceipt, type ObservationHealth } from '@/components/companion/presentation';
import { initializeLocale, I18nProvider, useI18n, type I18nKey } from '@/lib/i18n';
import { CompanionSceneFacts, reviewSceneFact, sceneForIntent, type SceneFact } from '@/components/companion/sceneFacts';
import { useCompanionScene } from '@/components/companion/useCompanionScene';
import catalog from '../../../../tools/desktop-companion-animation/coverage.json';
import { companionAssetBase } from '@varin/application-client';

// The companion window entry is mounted once; it is not a hot-reloaded component module.
// eslint-disable-next-line react-refresh/only-export-components
function CompanionApp({ apis }: { apis: RuntimeAPIs }) {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const accentPalette = React.useMemo(() => resolveCompanionAccentPalette(currentTheme), [currentTheme]);
  const review = new URLSearchParams(window.location.search).get('review') === '1';
  const [reviewStageOnly, setReviewStageOnly] = React.useState(false);
  const reviewChrome = review && !reviewStageOnly;
  const restoreReview = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!review || !reviewStageOnly) return;
    restoreReview.current?.focus();
    const restore = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setReviewStageOnly(false); } };
    window.addEventListener('keydown', restore);
    return () => window.removeEventListener('keydown', restore);
  }, [review, reviewStageOnly]);
  const [directorEnabled, setDirectorEnabled] = React.useState(() => review && new URLSearchParams(window.location.search).get('director') === '1');
  const [selectedReviewEnabled, setSelectedReviewEnabled] = React.useState(false);
  const directorReview = review && directorEnabled;
  const selectedDirectorReview = review && selectedReviewEnabled && !directorEnabled;
  const directorReviewControls = directorReview || selectedDirectorReview;
  const [reviewBundleIdentity, setReviewBundleIdentity] = React.useState('');
  const [bundledEpoch, setBundledEpoch] = React.useState<string | null>(null);
  const [visibleDrawing, setVisibleDrawing] = React.useState<DesktopCompanionDrawing>();
  const lastVisibleDrawingKey = React.useRef('');
  const [fixtureMode, setFixtureMode] = React.useState(false);
  const [fixtureStep, setFixtureStep] = React.useState<DirectorReviewStep>('portfolio');
  const [fixtureInspection, setFixtureInspection] = React.useState<ThreadIdentity | null | undefined>();
  const fixtureSession = React.useMemo(createDirectorReviewFixtureSession, []);
  const [, refreshFixture] = React.useReducer((v: number) => v + 1, 0);
  const fixtureActive = directorReviewControls && fixtureMode;
  const [hideTaskNames, setHideTaskNames] = React.useState(false);
  const [finishedDirectorSentence, setFinishedDirectorSentence] = React.useState<string | null>(null);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const attention = useCompanionAttention(apis.threads, generation);
  const teamProjector = React.useRef(new CompanionChildTeam());
  const [attentionOpen, setAttentionOpen] = React.useState(false);
  const [controlsOpen, setControlsOpen] = React.useState(false);
  // Who she speaks for is the user's explicit choice (or the default Bot), never the shell.
  const companion = useCompanionAssociation(apis.bots, generation, controlsOpen);
  const productMode = companion.association.route;
  const associatedBot = companion.association.botId;
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [threadListUnavailable, setThreadListUnavailable] = React.useState(false);
  const [selected, setSelected] = React.useState<{ generation: number; identity: ThreadIdentity } | null>(null);
  const [observedSnapshot, setSnapshot] = React.useState<ThreadSnapshot>();
  const snapshot = selected?.generation === generation && observedSnapshot?.identity.threadId === selected.identity.threadId
    && observedSnapshot.identity.branchId === selected.identity.branchId ? observedSnapshot : undefined;
  const previousRun = React.useRef<{ id: string; state: string } | null>(null);
  const [liveCompletion, setLiveCompletion] = React.useState<string | null>(null);
  const pendingQuestions = React.useRef(new Set<string>());
  const [receipt, setReceipt] = React.useState<CompanionReceipt | null>(null);
  const sceneFacts = React.useRef(new CompanionSceneFacts());
  const sceneScope = React.useRef(0);
  const sceneIdentity = React.useRef('');
  const nextSceneIdentity = JSON.stringify([generation, selected?.identity ?? null, attention.observationRevision]);
  if (sceneIdentity.current !== nextSceneIdentity) { sceneIdentity.current = nextSceneIdentity; sceneScope.current++; }
  const [sceneFact, setSceneFact] = React.useState<SceneFact>(() => sceneFacts.current.reset());
  const [observedHealth, setHealth] = React.useState<ObservationHealth>('unselected');
  const health: ObservationHealth = !selected || selected.generation !== generation ? 'unselected'
    : observedHealth === 'unselected' || observedHealth === 'current' && !snapshot ? 'synchronizing' : observedHealth;
  const [connection, setConnection] = React.useState('No thread selected');
  const [error, setError] = React.useState('');
  const [asset, setAsset] = React.useState<CompanionPackage>();
  const [assetList, setAssetList] = React.useState<CompanionPackage[]>([]);
  const [bundleEndpoints, setBundleEndpoints] = React.useState<CompanionEndpoints | null>(null);
  const directorMode = companionDirectorMode(assetList, review, directorReview, bundleEndpoints, selectedDirectorReview);
  const [imageLibrary, setImageLibrary] = React.useState<Record<string, ImageBitmap[]>>({});
  const imageCache = React.useRef<Record<string, ImageBitmap[]>>({});
  const atlasReader = React.useRef<((name: string) => Promise<ImageBitmap>) | null>(null);
  const loadingImages = React.useRef(new Map<string, object>());
  const decodedPages = React.useRef(new Map<string, { promise: Promise<ImageBitmap>; image?: ImageBitmap }>());
  const wantedImages = React.useRef(new Set<string>());
  const wantedAtlasFiles = React.useRef(new Set<string>());
  const [playing, setPlaying] = React.useState(false);
  const [manualReview, setManualReview] = React.useState(false);
  const [exposure, setExposure] = React.useState(0);
  const [visibleCue, setVisibleCue] = React.useState<{ cue: ReturnType<typeof sceneCue>; instance: number; action: string | undefined; context: string | null }>();
  const visibleCueCounter = React.useRef(0);
  const lastVisibleCue = React.useRef('');
  const [presentation, setPresentation] = React.useState('C01');
  const [reviewRoute, setReviewRoute] = React.useState(false);
  const [directorLocal, setDirectorLocal] = React.useState<{ action: NonNullable<ReturnType<typeof directorLocalResponse>>; context: string; event: 'tap' | 'tap-repeat' | 'hover' } | null>(null);
  const discardDirectorTransient = React.useRef<() => void>(() => {});
  const [localAction, setLocalAction] = React.useState<'welcome' | 'tap-response' | 'hover-response' | null>(review ? null : 'welcome');
  const progressFacts = React.useRef(new CompanionProgressFacts());
  const canAnimateEdges = React.useRef(true);
  const focusedProjection = React.useRef<ThreadProjection | null>(null);
  const [outputBeat, setOutputBeat] = React.useState(false);
  const lastOutputBeat = React.useRef({ event: 0, at: -Infinity });
  const [providerScope, setProviderScope] = React.useState<string | null>(null);
  const [providerProgress, setProviderProgress] = React.useState<CompanionProgress | null>(null);
  React.useEffect(() => {
    if (!providerProgress) return;
    // Expiration changes presentation only, never retries or completes Host work.
    const delay = Math.max(0, Math.min(2_147_483_647, providerProgress.until - Date.now()));
    const timer = window.setTimeout(() => setProviderProgress(current => current === providerProgress ? (current.until <= Date.now() ? null : { ...current }) : current), delay);
    return () => window.clearTimeout(timer);
  }, [providerProgress]);
  const intent = withCompanionProgress(projectCompanionIntent(snapshot, health), providerProgress, health, snapshot?.activeRun, Date.now());
  const stableIntent = useCompanionVisualIntent(JSON.stringify([generation, attention.observationRevision, selected?.identity, snapshot?.activeRun?.id, providerScope]), intent);
  const visualIntent = review && reviewRoute ? { state: presentation, reason: 'Explicit presentation review, not Host facts' } : stableIntent;
  const team = teamProjector.current.observe(snapshot, health, generation);
  const observedNativeIdle = companionLocalIdle(attention.snapshot, attention.health);
  // Shared neutral/attentive performances are visual fallbacks, not invented tool categories.
  const receiptScope = JSON.stringify([generation, attention.observationRevision, selected?.identity ?? null, productMode, associatedBot, directorMode, fixtureActive]);
  const receiptBlocked = document.hidden || manualReview || reviewRoute || fixtureActive || controlsOpen || attentionOpen || !canAnimateEdges.current
    || health !== 'current' || ['W02', 'W03', 'C06'].includes(intent.state ?? '') || !!intent.state?.startsWith('E');
  const currentReceipt = currentCompanionReceipt(receipt, receiptScope, receiptBlocked, snapshot?.activeRun?.id ?? null);
  const liveAnswer = currentReceipt?.kind === 'question';
  const livePermissionReceipt = currentReceipt?.kind === 'permission';
  const requestedAction = !reviewRoute && liveAnswer && health === 'current' && visualIntent.state !== 'C06' && visualIntent.state !== 'W02' && visualIntent.state !== 'W03' && !visualIntent.state?.startsWith('E') ? 'understood' : visualIntent.state === 'L07' || (!reviewRoute && visualIntent.state === 'C06' && liveCompletion !== snapshot?.activeRun?.id)
    ? 'idle-closed'
    : visualIntent.state === null ? (snapshot?.activeRun?.state === 'cancelled' ? 'idle-closed' : 'external-wait')
    : catalog.states.find(state => state.id === visualIntent.state)?.requires[0] ?? null;
  const hasActiveWork = (!!snapshot?.activeRun && !['completed', 'failed', 'cancelled'].includes(snapshot.activeRun.state))
    || (snapshot?.operations.some(operation => operation.phase !== 'terminal') ?? false)
    || hasCurrentChildWork(snapshot)
    || (reviewRoute && /^(C0[2345]|T|W)/.test(presentation));
  const localReviewAction: Record<string, string> = { L01: 'welcome', L02: 'idle-closed', L06: assetList.some(item => item.action === 'relax-idle' && item.reviewStatus === 'accepted') ? 'relax-idle' : 'idle-closed', L07: 'idle-closed', E03: 'idle-closed' };
  const permissionAcknowledgement = !reviewRoute && livePermissionReceipt && health === 'current'
    && !['W02','W03','C06'].includes(visualIntent.state ?? '') && !visualIntent.state?.startsWith('E')
    && assetList.some(item => item.action === 'permission-allowed' && item.reviewStatus === 'accepted');
  const taskAction = outputBeat && visualIntent.state === 'C05' ? 'output-emphasis' : permissionAcknowledgement ? 'permission-allowed' : reviewRoute && localReviewAction[presentation] ? localReviewAction[presentation]!
    : visualIntent.state === 'E05' ? (assetList.some(item => item.action === 'reconnecting' && item.reviewStatus === 'accepted') ? 'reconnecting' : 'disconnected') : visualIntent.state === 'T03' && requestedAction !== 'understood' ? 'execution-observe' : requestedAction;
  const preferredAction = companionObserverAction(taskAction, review && reviewRoute);
  const visualAction = preferredAction && assetList.some(item => item.action === preferredAction && item.reviewStatus === 'accepted' && item.stage === 'motion-candidate' && item.geometryReference && item.entryPose && item.exitPose) ? preferredAction
    : hasActiveWork && !visualIntent.state?.startsWith('E') ? 'external-wait' : preferredAction;
  const localAllowed = !reviewRoute && !manualReview && !hasActiveWork && !liveCompletion && !['W02','W03','E01','E02','E04','E05','E06'].includes(intent.state ?? '');
  const primaryAction = localAction && localAllowed && assetList.some(item => item.action === localAction && item.reviewStatus === 'accepted') ? localAction : visualAction;
  React.useEffect(() => {
    if (document.hidden || !canAnimateEdges.current || intent.state !== 'C05' || health !== 'current') { setOutputBeat(false); return; }
    const event = providerProgress?.textEvent;
    if (!event || lastOutputBeat.current.event === event) return;
    lastOutputBeat.current.event = event;
    const now = Date.now();
    if (outputBeat || now - lastOutputBeat.current.at < 1200) return;
    if (assetList.some(item => item.action === 'output-emphasis' && item.reviewStatus === 'accepted')) {
      lastOutputBeat.current.at = now; setOutputBeat(true);
    }
  }, [providerProgress, intent.state, health, assetList, outputBeat]);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const paintSurface = React.useRef<HTMLCanvasElement | null>(null);
  const accentMaterial = React.useRef(new CompanionAccentMaterial());
  const beforeNativeLift = React.useRef<() => void>(() => {});
  const repeatTapAllowed = React.useRef(false);
  const companionWindow = useCompanionWindow(canvas, review, () => beforeNativeLift.current(), () => repeatTapAllowed.current);
  canAnimateEdges.current = companionWindow.phase === 'rest';
  React.useEffect(() => {
    if (companionWindow.phase !== 'rest') { setDirectorLocal(null); discardDirectorTransient.current(); setLiveCompletion(null); setReceipt(null); setOutputBeat(false); setLocalAction(null); }
  }, [companionWindow.phase]);
  React.useEffect(() => {
    const visibility = () => {
      setDirectorLocal(null); discardDirectorTransient.current();
      setLiveCompletion(null); setReceipt(null); setOutputBeat(false); setLocalAction(null);
      setProviderProgress(current => current?.kind === 'retry' ? current : null);
      if (!document.hidden) { attention.refresh(); void focusedProjection.current?.refresh(); }
    };
    document.addEventListener('visibilitychange', visibility);
    if (document.hidden) visibility();
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [attention.refresh]);
  const liveDirector = useCompanionDirector(directorMode && !fixtureActive ? attention : { ...attention, snapshot: null, health: 'unknown' }, selected?.generation === generation ? selected.identity : null, generation,
    { visible: directorMode && !document.hidden, interacting: companionWindow.phase !== 'rest', cardCapacity: 3, interactionRoute: productMode, botId: associatedBot });
  const directorDetail = directorToolDetail(snapshot, health);
  const livePortfolio = useDirectorPortfolio(liveDirector, directorMode && !fixtureActive ? attention.snapshot : null, generation, directorMode && !fixtureActive && directorDetail ? [directorDetail] : [], { hideTaskNames });
  const fixtureView = fixtureActive ? fixtureSession.view({ visible: !document.hidden, interacting: companionWindow.phase !== 'rest', inspected: fixtureInspection, hideTaskNames }) : null;
  const director = fixtureView ? { ...fixtureView.presentation, consumeEdge: (key: string) => { fixtureSession.consumeEdge(key); refreshFixture(); }, discardTransient: () => { fixtureSession.discardTransient(); refreshFixture(); } } : liveDirector;
  discardDirectorTransient.current = director.discardTransient;
  const portfolioProjection = fixtureView?.projection ?? livePortfolio;
  const localInteractionIdle = fixtureView ? companionLocalIdle(fixtureView.attention, fixtureView.presentation.health) : observedNativeIdle;
  const selectFixture = (step: DirectorReviewStep) => { fixtureSession.step(step); setFixtureStep(step); setFinishedDirectorSentence(null); setManualReview(false); setPlaying(false); refreshFixture(); };
  const rawScene = sceneForIntent(sceneFact, intent.state);
  const sceneCurrent = review && reviewRoute ? reviewSceneFact(presentation)
    : stableIntent.state !== intent.state && rawScene.phase === 'active' ? { kind: null, phase: 'withdraw', outcome: null, count: null } as SceneFact : rawScene;
  const directorContextKey = JSON.stringify([directorReview ? 'candidate' : 'selected', fixtureActive ? `offline-fixture-${fixtureStep}` : generation, director.interactionRoute, director.body.subjectRoute, director.inspectionRoute, director.body.verb, director.body.workActive, director.body.activity?.key, director.body.edge?.key, director.body.attentionItem?.key, portfolioProjection.portfolio.subjectKey ?? director.inspectedProjectKey]);
  useCompanionScene(canvas, sceneCurrent, directorMode ? fixtureActive ? `director-explicit-offline-fixture-${directorReview ? 'candidate' : 'selected'}` : `director-${generation}-${attention.snapshot?.epoch ?? 'unknown'}` : `scene-${sceneScope.current}${reviewRoute ? '-review' : ''}`,
    companionWindow.phase !== 'rest' || (!directorMode && !reviewRoute && health !== 'current' && sceneCurrent.kind !== 'status') || manualReview, controlsOpen || attentionOpen, visibleCue, directorMode || reviewRoute ? undefined : team, directorMode ? portfolioProjection.portfolio : undefined, directorMode ? directorContextKey : null, visibleDrawing, directorMode);
  const usableAction = (action: string) => assetList.some(item => item.action === action && (item.reviewStatus === 'accepted' || directorReview && item.reviewStatus === 'candidate'));
  const availableQuietActions = COMPANION_QUIET_ACTIONS.filter(usableAction);
  const { restDue, quietAction, finishQuiet } = useCompanionLeisure((directorMode ? !fixtureActive && director.health === 'current' && director.body.verb === 'available' : localAllowed) && !!observedNativeIdle && companionWindow.phase === 'rest' && !controlsOpen && !attentionOpen && (directorMode || health === 'current' || health === 'unselected'), companionWindow.activityRevision, availableQuietActions.length > 0, availableQuietActions);
  const ordinaryDisplayAction = quietAction && !localAction && usableAction(quietAction) ? quietAction : restDue && !localAction && assetList.some(item => item.action === 'rest-sleep' && item.reviewStatus === 'accepted') ? 'rest-sleep' : primaryAction;
  const seenHover = React.useRef(0);
  // Optional expressions must have an authored route from the actual shown package.
  // An incompatible permission/query asset falls back to the existing neutral notice.
  const directorAssets = assetList.filter((item): item is PlaybackAsset =>
    (item.reviewStatus === 'accepted' || directorReview && item.reviewStatus === 'candidate') && item.stage === 'motion-candidate'
    && !!item.geometryReference && !!item.entryPose && !!item.exitPose);
  const shownDirectorAsset = directorAssets.find(item => item.id === visibleDrawing?.packageId) ?? null;
  const usableDirectorExpression = (action: string) => directorAssets.some(item => item.action === action
    && route(shownDirectorAsset, item, directorAssets, directorReview).status === 'ready');
  const directorRequestedAction = directorBodyAction(director, null, usableAction('director-notify-attention'), usableDirectorExpression);
  const directorSentenceKey = directorContextKey;
  const directorBaseAction = finishedDirectorSentence === directorSentenceKey && !['idle-closed', 'work-active'].includes(directorRequestedAction) ? 'director-supervise' : directorRequestedAction;
  const directorLocalAction = directorLocal?.context === directorContextKey && director.health === 'current' && companionWindow.phase === 'rest' && !manualReview ? directorLocal.action : null;
  const directorWelcome = directorMode && localAction === 'welcome' && director.health === 'current' && director.body.verb === 'available' && usableAction('welcome');
  const finiteReceiptHandover = !!director.body.edge || ['director-intake', 'director-gather-present', 'completion', 'failure'].includes(directorBaseAction)
    || !!shownDirectorAsset && ['director-intake', 'director-gather-present', 'completion', 'failure'].includes(shownDirectorAsset.action ?? '')
      && (visibleDrawing?.frameIndex ?? 0) < shownDirectorAsset.frames.length - 1;
  const directorReceiptBlocked = companionWindow.phase !== 'rest' || directorMode && (director.interactionRoute !== 'agent-companion' || director.health !== 'current'
    || !!director.body.attentionItem || (attention.snapshot?.counts.actionRequired ?? 0) > 0 || (attention.snapshot?.counts.unknownEffects ?? 0) > 0
    || !!director.body.subject && (director.body.subject.threadId !== selected?.identity.threadId || director.body.subject.branchId !== selected?.identity.branchId)
    || finiteReceiptHandover || !!directorLocalAction);
  const receiptAction = currentReceipt && !directorReceiptBlocked
    ? directorMode ? usableDirectorExpression('receipt-ack') ? 'receipt-ack' : null
      : currentReceipt.kind === 'question' ? 'understood' : 'permission-allowed'
    : null;
  const receiptProducerBlocked = React.useRef(false);
  // The callback sees the *next* Host intent. Do not suppress a real receipt
  // using the previous render's still-pending request or synchronizing health.
  receiptProducerBlocked.current = document.hidden || manualReview || reviewRoute || fixtureActive || controlsOpen || attentionOpen
    || companionWindow.phase !== 'rest' || directorMode && (productMode !== 'agent-companion' || finiteReceiptHandover);
  React.useEffect(() => {
    if (receiptBlocked || directorReceiptBlocked || directorMode && !receiptAction || receipt?.scope !== receiptScope || receipt?.runId !== (snapshot?.activeRun?.id ?? null)) setReceipt(null);
  }, [receiptBlocked, directorReceiptBlocked, directorMode, receiptAction, receiptScope, receipt, snapshot?.activeRun?.id]);
  const displayAction = directorMode ? receiptAction ?? directorLocalAction ?? (directorWelcome ? 'welcome' : quietAction && usableAction(quietAction) ? quietAction : restDue && usableAction('rest-sleep') ? 'rest-sleep' : directorBaseAction) : ordinaryDisplayAction;
  repeatTapAllowed.current = directorMode && localInteractionIdle && director.health === 'current' && !directorLocalAction && usableAction('tap-repeat-response');
  const localDirectorResponseRef = React.useRef<(event: 'tap' | 'tap-repeat' | 'hover') => void>(() => {});
  const localDirectorResponse = React.useCallback((event: 'tap' | 'tap-repeat' | 'hover') => localDirectorResponseRef.current(event), []);
  localDirectorResponseRef.current = (event) => {
    const shown = assetList.find(item => item.id === displayedDrawing.current?.packageId);
    const shownFrame = shown?.frames[displayedDrawing.current?.exposure ?? -1];
    const decision = directorLocalResponse({ event, responseAvailable: usableDirectorExpression, idle: localInteractionIdle, responsePlaying: !!directorLocalAction,
      // A stable open listening hand pose first takes the existing actual-source
      // recovery bridge to the response's open-user entrance; it is never cut.
      safeOpenEndpoint: companionSafeOpenDrawing(shown, shownFrame, bundleEndpoints),
      playfulAvailable: usableAction('tap-repeat-response'),
      closedPlayfulAvailable: assetList.some(item => item.action === 'tap-repeat-response' && companionClosedSequence(item, bundleEndpoints) && (item.reviewStatus === 'accepted' || directorReview && item.reviewStatus === 'candidate')), openHoverAvailable: usableAction('open-hover-response'), current: director.health === 'current', visible: !document.hidden,
      interacting: companionWindow.phase !== 'rest', blockedUI: controlsOpen || attentionOpen || manualReview,
      finiteHandover: ['director-intake', 'director-gather-present'].includes(directorBaseAction)
        || !!shown && ['director-intake', 'director-gather-present'].includes(shown.action ?? '') && (displayedDrawing.current?.exposure ?? 0) < shown.frames.length - 1,
      closed: companionClosedDrawing(shown, shownFrame, bundleEndpoints) });
    if (!decision) return;
    // End this inspection sentence, not its project facts; do not replay LISTEN.
    if (usableAction(decision)) {
      if (directorBaseAction === 'director-inspect') setFinishedDirectorSentence(directorSentenceKey);
      setDirectorLocal({ action: decision, context: directorContextKey, event });
    }
  };
  React.useEffect(() => { setDirectorLocal(null); companionWindow.resetLocalInteraction(); }, [directorContextKey, directorMode, director.health, controlsOpen, attentionOpen, manualReview, companionWindow.resetLocalInteraction]);
  React.useEffect(() => {
    if (!directorMode || localAction !== 'welcome' || director.health !== 'current' || director.body.verb === 'available') return;
    // The once-per-window greeting is an observed local opening, not a Run or
    // reconnect edge. Busy windows acknowledge briefly only if safe now; never queue it.
    setLocalAction(null); localDirectorResponse('tap');
  }, [directorMode, localAction, director.health, director.body.verb, localDirectorResponse]);

  React.useEffect(() => {
    if (!companionWindow.hoverRevision || seenHover.current === companionWindow.hoverRevision) return;
    seenHover.current = companionWindow.hoverRevision;
    if (directorMode) { localDirectorResponse('hover'); return; }
    const shown = assetList.find(item => item.id === displayedDrawing.current?.packageId);
    // Closed-only attention must not close an open laptop merely to react to hover.
    if (localAllowed && !controlsOpen && shown && assetList.some(item => item.action === 'hover-response' && item.reviewStatus === 'accepted' && item.geometryReference === shown.geometryReference && item.entryPose === shown.entryPose && item.exitPose === shown.exitPose)) setLocalAction('hover-response');
  }, [companionWindow.hoverRevision, localAllowed, controlsOpen, assetList, directorMode, localDirectorResponse]);
  React.useEffect(() => { if (!companionWindow.hovered) { setLocalAction(current => current === 'hover-response' ? null : current); setDirectorLocal(current => current?.event === 'hover' ? null : current); } }, [companionWindow.hovered]);
  const displayedDrawing = React.useRef<{ packageId: string; exposure: number; context: string | null } | null>(null);
  const automatic = useCompanionPlayback(assetList, displayAction, playing || manualReview, Object.keys(imageLibrary), { phase: companionWindow.phase, displayed: () => displayedDrawing.current }, { allowCandidates: directorReview, presentationKey: receiptAction && displayAction === receiptAction ? currentReceipt?.key : directorMode ? directorContextKey : null });
  React.useEffect(() => {
    if (directorMode && automatic.context === directorContextKey && automatic.finished && !['director-supervise', 'work-active'].includes(directorRequestedAction)
      && assetList.find(item => item.id === automatic.packageId)?.action === directorRequestedAction) {
      setFinishedDirectorSentence(directorSentenceKey);
      if (director.body.edge) director.consumeEdge(director.body.edge.key);
    }
  }, [directorMode, automatic.finished, automatic.context, directorContextKey, automatic.packageId, directorRequestedAction, directorSentenceKey, assetList]);
  const pendingStopEdge = director.body.edge?.kind === 'executor-stopped' ? director.body.edge.key : null;
  const consumeDirectorEdge = director.consumeEdge;
  React.useEffect(() => {
    // A stop receipt owns a safe recovery, not a looping "all stopped" pose.
    // Consume only after the current context actually painted its safe observation frame.
    if (directorMode && !manualReview && pendingStopEdge && directorStopRecoveryReady('executor-stopped',
      visibleDrawing ? { action: shownDirectorAsset?.action, context: visibleCue?.context,
        pauseSafe: shownDirectorAsset?.frames[visibleDrawing.frameIndex]?.pauseSafe } : null, directorContextKey)) {
      consumeDirectorEdge(pendingStopEdge);
    }
  }, [directorMode, manualReview, pendingStopEdge, consumeDirectorEdge, visibleCue?.context, directorContextKey, shownDirectorAsset, visibleDrawing]);
  React.useEffect(() => {
    if (automatic.finished && COMPANION_QUIET_ACTIONS.some(action => action === assetList.find(item => item.id === automatic.packageId)?.action)) finishQuiet();
    if (automatic.finished && assetList.find(item => item.id === automatic.packageId)?.action === 'output-emphasis') setOutputBeat(false);
    if (automatic.finished && assetList.find(item => item.id === automatic.packageId)?.action === 'completion') setLiveCompletion(null);
    if (automatic.finished && ['receipt-ack', 'permission-allowed', 'understood'].includes(assetList.find(item => item.id === automatic.packageId)?.action ?? ''))
      setReceipt(current => consumeCompanionReceipt(current, automatic.context));
    if (automatic.finished && assetList.find(item => item.id === automatic.packageId)?.action === directorLocalAction) setDirectorLocal(null);
    if (automatic.finished && assetList.find(item => item.id === automatic.packageId)?.action === localAction) setLocalAction(null);
  }, [automatic.finished, automatic.context, automatic.packageId, assetList, localAction, directorLocalAction, finishQuiet]);

  // A local greeting/tap is not a queued application event. Higher-priority facts
  // discard it instead of replaying it after a permission or interruption clears.
  React.useEffect(() => { if (!localAllowed) setLocalAction(null); }, [localAllowed]);
  const seenTap = React.useRef(0);
  React.useEffect(() => {
    if (!companionWindow.tapRevision || seenTap.current === companionWindow.tapRevision) return;
    seenTap.current = companionWindow.tapRevision;
    if (directorMode) { localDirectorResponse(companionWindow.tapKind === 'tap-repeat' ? 'tap-repeat' : 'tap'); return; }
    if (!localAllowed) return;
    const current = assetList.find(item => item.id === automatic.packageId);
    // Identity-specific pose names are artwork contracts, not UI prefix conventions.
    // The existing player chooses the nearest authored tap variant and its safe bridge.
    if (current && assetList.some(item => item.action === 'tap-response' && item.reviewStatus === 'accepted' && item.geometryReference === current.geometryReference)) setLocalAction('tap-response');
  }, [companionWindow.tapRevision, assetList, automatic.packageId, localAllowed, directorMode, localDirectorResponse]);
  const pictures = asset ? imageLibrary[asset.id] ?? [] : [];
  const displayedExposure = !playing && !manualReview && automatic.packageId === asset?.id ? automatic.exposure : exposure;
  const loadGeneration = React.useRef(0);
  React.useEffect(() => {
    const abort = new AbortController();
    setThreads([]); setSelected(null); setSnapshot(undefined); setConnection('No thread selected'); setHealth('unselected');
    if (apis.threads) void apis.threads.list(undefined, abort.signal).then(rows => { if (!abort.signal.aborted) setThreads(rows); })
      .catch(cause => { if (!abort.signal.aborted) setConnection(String(cause)); });
    return () => abort.abort();
  }, [apis.threads, generation]);
  React.useEffect(() => {
    if (!controlsOpen || !apis.threads) return;
    const abort = new AbortController();
    setThreadListUnavailable(false);
    void apis.threads.list(undefined, abort.signal).then(rows => { if (!abort.signal.aborted) setThreads(rows); })
      .catch(() => { if (!abort.signal.aborted) setThreadListUnavailable(true); });
    // Refresh discovery only. Selection and its read-only projection remain authoritative.
    return () => abort.abort();
  }, [controlsOpen, apis.threads, generation]);
  React.useEffect(() => {
    if (selected) setLocalAction(null);
    setReceipt(null);
    setProviderScope(null); setProviderProgress(progressFacts.current.reset()); setOutputBeat(false); lastOutputBeat.current = { event: 0, at: -Infinity };
    setSceneFact(sceneFacts.current.reset());
    setSnapshot(undefined); previousRun.current = null; setLiveCompletion(null); pendingQuestions.current.clear();
    if (!attention.projectionAPI || !selected || selected.generation !== generation) { setConnection('No thread selected'); setHealth('unselected'); return; }
    let closed = false;
    setConnection('Synchronizing current Host snapshot'); setHealth('synchronizing');
    const projection = new ThreadProjection(attention.projectionAPI, selected.identity,
      value => { if (!closed) {
        // Observe each projection callback before React can coalesce short tool snapshots.
        const nextScene = sceneFacts.current.observe(value, 'current');
        setSceneFact(nextScene);
        const answered = newlyAnsweredQuestion(pendingQuestions.current, value);
        const proof = sceneFacts.current.matchedReceipt;
        const matched = answered ? { kind: 'question' as const, operationId: answered, outcome: 'answered' as const } : proof;
        const operation = matched ? value.operations.find(row => row.id === matched.operationId) : null;
        const nextReceipt = matched && (!value.activeRun || operation?.run_id === value.activeRun.id)
          ? companionReceipt(receiptScope, matched, value.activeRun?.id ?? null) : null;
        if (nextReceipt && !document.hidden && canAnimateEdges.current && !receiptProducerBlocked.current) setReceipt(nextReceipt);
        pendingQuestions.current = new Set(value.operations.filter(operation => operation.executor === 'ask_user' && operation.phase !== 'terminal').map(operation => operation.id));
        const nextIntent = projectCompanionIntent(value, 'current');
        if (nextIntent.state === 'W02' || nextIntent.state === 'W03' || nextIntent.state?.startsWith('E')) { setReceipt(null); setLiveCompletion(null); }
        const nextRun = value.activeRun, previous = previousRun.current;
        if (nextRun?.id !== previous?.id) setLiveCompletion(null);
        if (nextRun && ['completed', 'failed', 'cancelled'].includes(nextRun.state)) { setReceipt(null); }
        if (!document.hidden && canAnimateEdges.current && nextRun?.state === 'completed' && previous?.id === nextRun.id && !['completed','failed','cancelled'].includes(previous.state)) setLiveCompletion(nextRun.id);
        previousRun.current = nextRun ? { id: nextRun.id, state: nextRun.state } : null;
        setSnapshot(value); setHealth('current'); setConnection('Observing existing thread — read only'); } },
      cause => { if (!closed) { setProviderScope(null); setProviderProgress(progressFacts.current.reset()); setReceipt(null); setSceneFact(sceneFacts.current.reset()); setHealth('unknown'); previousRun.current = null; setLiveCompletion(null); pendingQuestions.current.clear(); setConnection(`Connection unknown: ${String(cause)}`); } },
      (parts, context) => { if (!closed) { setProviderScope(context ? JSON.stringify([context.runId, context.requestId ?? null]) : null); setProviderProgress(progressFacts.current.observe(parts, context, Date.now())); } }, undefined, undefined, { contextInspection: false });
    focusedProjection.current = projection; projection.start();
    return () => { closed = true; if (focusedProjection.current === projection) focusedProjection.current = null; projection.close(); };
  }, [attention.projectionAPI, attention.observationRevision, selected, generation, receiptScope]);
  React.useEffect(() => () => {
    loadGeneration.current++;
    for (const page of decodedPages.current.values()) page.image?.close();
    decodedPages.current.clear();
  }, []);
  const installBundle = async (raw: unknown, readImage: (name: string) => Promise<ImageBitmap>, allowCandidates: boolean, manualSelection = false) => {
    ++loadGeneration.current;
    accentMaterial.current.clear();
    if (manualSelection) { setBundledEpoch(null); setVisibleDrawing(undefined); lastVisibleDrawingKey.current = ''; }
    setPlaying(false); setError('');
    try {
      const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      if (!allowCandidates && data.candidateOnly === true) throw new Error('Review-only artwork cannot be installed for normal playback');
      const nextPackages = Array.isArray(data.packages) ? data.packages.map(value => readCompanionPackage(value, allowCandidates)) : [readCompanionPackage(raw, allowCandidates)];
      if (!nextPackages.length || new Set(nextPackages.map(item => item.id)).size !== nextPackages.length) throw new Error('Empty bundle or duplicate sequence identity');
      const nextEndpoints = readCompanionEndpoints(data.endpoints, nextPackages);
      for (const page of decodedPages.current.values()) page.image?.close();
      decodedPages.current.clear();
      imageCache.current = {}; loadingImages.current.clear(); atlasReader.current = readImage;
      setImageLibrary({}); setAssetList(nextPackages); setBundleEndpoints(nextEndpoints);
      setAsset(manualSelection ? nextPackages[0] : undefined); setExposure(0);
    } catch (cause) { setError(String(cause)); }
  };
  // Decode only the displayed package and the controller's next bridge/target.
  // While decoding, the controller keeps the last valid drawing; Host facts update immediately.
  React.useEffect(() => {
    const wanted = new Set([asset?.id, automatic.packageId, automatic.neededPackageId].filter((id): id is string => !!id));
    const pickupDependencies = pickupPreloadDependencies(assetList.filter(item =>
      (item.reviewStatus === 'accepted' || directorReview && item.reviewStatus === 'candidate') && item.stage === 'motion-candidate'
      && !!item.entryPose && !!item.exitPose && !!item.geometryReference));
    for (const id of [...wanted]) {
      for (const next of pickupDependencies.get(id) ?? []) wanted.add(next);
    }
    wantedImages.current = wanted;
    // A package may return while its old page promises are still settling. Invalidate
    // the old job now so it cannot publish closed pages or delete its replacement.
    for (const id of loadingImages.current.keys()) if (!wanted.has(id)) loadingImages.current.delete(id);
    const wantedPages = new Set(assetList.filter(item => wanted.has(item.id)).flatMap(item => item.pages.map(page => page.file)));
    wantedAtlasFiles.current = wantedPages;
    for (const [file, page] of decodedPages.current) if (!wantedPages.has(file) && page.image) { page.image.close(); decodedPages.current.delete(file); }
    let evicted = false;
    for (const id of Object.keys(imageCache.current)) if (!wanted.has(id)) {
      delete imageCache.current[id]; evicted = true;
    }
    if (evicted) setImageLibrary({ ...imageCache.current });
    for (const id of wanted) {
      if (imageCache.current[id] || loadingImages.current.has(id)) continue;
      const sequence = assetList.find(item => item.id === id), reader = atlasReader.current;
      if (!sequence || !reader) continue;
      const revision = loadGeneration.current;
      const job = {};
      loadingImages.current.set(id, job);
      void (async () => {
        const isCurrent = () => revision === loadGeneration.current && loadingImages.current.get(id) === job;
        const images: ImageBitmap[] = [];
        try {
          for (const page of sequence.pages) {
            if (!isCurrent()) return;
            let cached = decodedPages.current.get(page.file);
            if (!cached) {
              const created: { promise: Promise<ImageBitmap>; image?: ImageBitmap } = { promise: reader(page.file) };
              created.promise = created.promise.then(image => {
                if (revision !== loadGeneration.current || !wantedAtlasFiles.current.has(page.file)) { image.close(); throw new Error('Superseded artwork load'); }
                created.image = image; return image;
              }).catch(cause => { if (decodedPages.current.get(page.file) === created) decodedPages.current.delete(page.file); throw cause; });
              decodedPages.current.set(page.file, created); cached = created;
            }
            const image = await cached.promise;
            if (!isCurrent()) return;
            images.push(image);
          }
          for (const frame of sequence.frames) {
            const image = images[frame.page]!;
            if (frame.rect[0] + frame.rect[2] > image.width || frame.rect[1] + frame.rect[3] > image.height) throw new Error('Atlas region exceeds actual image');
          }
          if (!isCurrent() || !wantedImages.current.has(id)) return;
          imageCache.current[id] = images; setImageLibrary({ ...imageCache.current });
        } catch (cause) { if (isCurrent() && wantedImages.current.has(id)) setError(String(cause)); }
        finally { if (isCurrent()) loadingImages.current.delete(id); }
      })();
    }
  }, [asset?.id, assetList, automatic.packageId, automatic.neededPackageId, imageLibrary, directorReview]);
  const loadFiles = async (files: FileList | null) => {
    if (!review || !files) return;
    setManualReview(true);
    ++loadGeneration.current; // A manual selection supersedes an in-flight bundled fetch.
    try {
      const all = [...files], json = all.filter(file => file.name.endsWith('.json'));
      if (json.length !== 1) throw new Error('Select one bundle.json or sequence.json and its PNG atlas pages');
      await installBundle(JSON.parse(await json[0]!.text()), async name => {
        const candidates = all.filter(file => file.name === name);
        if (candidates.length !== 1) throw new Error(`Missing or ambiguous atlas: ${name}`);
        return createImageBitmap(candidates[0]!);
      }, true, true);
    } catch (cause) { setError(String(cause)); }
  };
  React.useEffect(() => {
    const abort = new AbortController();
    const initialGeneration = loadGeneration.current;
    const base = new URL(companionAssetBase(window.location.href, directorReview), window.location.href);
    setManualReview(false); setPlaying(false); setAsset(undefined); setAssetList([]); setFinishedDirectorSentence(null); setReviewBundleIdentity(''); setBundledEpoch(null); setVisibleDrawing(undefined); lastVisibleDrawingKey.current = '';
    void fetch(new URL('bundle.json', base), { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('Bundled companion artwork is unavailable');
      const text = await response.text();
      const raw: unknown = JSON.parse(text);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (directorReview) {
        const completion = await fetch(new URL('review-assets.json', base), { signal: abort.signal });
        if (!completion.ok) throw new Error('Director review generation is not completely staged');
        const marker = await completion.json() as { reviewOnly?: boolean; candidateBundleSHA256?: string };
        if (!raw || typeof raw !== 'object' || !('candidateOnly' in raw) || raw.candidateOnly !== true || marker.reviewOnly !== true || marker.candidateBundleSHA256 !== digest) throw new Error('Director review generation identity mismatch');
        if (!abort.signal.aborted && loadGeneration.current === initialGeneration) setReviewBundleIdentity(digest);
      }
      if (!abort.signal.aborted && loadGeneration.current === initialGeneration) { setBundledEpoch(digest); await installBundle(raw, async name => {
        // Decoder has already restricted each page to a basename; no arbitrary URLs/paths.
        const atlasUrl = new URL(encodeURIComponent(name), base);
        atlasUrl.searchParams.set('epoch', digest);
        const image = await fetch(atlasUrl, { signal: abort.signal });
        if (!image.ok) throw new Error(`Bundled atlas unavailable: ${name}`);
        return createImageBitmap(await image.blob());
      }, directorReview); }
    }).catch(cause => { if (!abort.signal.aborted && loadGeneration.current === initialGeneration) setError(String(cause)); });
    return () => { abort.abort(); loadGeneration.current++; };
  }, [directorReview]);
  React.useEffect(() => {
    if (!playing && !manualReview && automatic.packageId) {
      const current = assetList.find(item => item.id === automatic.packageId);
      if (current && current.id !== asset?.id) setAsset(current);
    }
  }, [automatic.packageId, assetList, asset?.id, playing, manualReview]);
  const drawActualFrame = (sequence: CompanionPackage, images: ImageBitmap[], exposure: number) => {
    const node = canvas.current;
    if (!node) return;
    paintSurface.current ??= document.createElement('canvas');
    if (!paintCompanionFrame(node, paintSurface.current, sequence, images, exposure, stage => {
      accentMaterial.current.apply(stage, sequence, images[sequence.frames[exposure]!.page]!, exposure, bundledEpoch, accentPalette);
    })) return;
    const frame = sequence.frames[exposure]!;
    const cue = frame.cue ? sceneCue(frame.cue, sequence.sceneAction ?? sequence.action) : 'engaged';
    const drawnContext = !manualReview && !playing && automatic.packageId === sequence.id && automatic.exposure === exposure ? automatic.context : null;
    displayedDrawing.current = { packageId: sequence.id, exposure, context: drawnContext };
    const drawing = directorMode && bundledEpoch ? { bundle: directorReview ? 'review' as const : 'selected' as const, epoch: bundledEpoch, packageId: sequence.id, frameIndex: exposure } : undefined;
    const drawingKey = JSON.stringify(drawing) ?? '';
    if (lastVisibleDrawingKey.current !== drawingKey) { lastVisibleDrawingKey.current = drawingKey; setVisibleDrawing(drawing); }

    const cueKey = JSON.stringify([sequence.sceneAction ?? sequence.action, cue, drawnContext]);
    if (lastVisibleCue.current !== cueKey) {
      lastVisibleCue.current = cueKey;
      setVisibleCue({ cue, context: drawnContext, action: sequence.sceneAction ?? sequence.action, instance: ++visibleCueCounter.current });
    }
    companionWindow.refreshHitMask();
  };
  // Swap to the predecoded same-exposure drawing before sending native movement,
  // rather than letting an embedded stool travel for a React/animation frame.
  beforeNativeLift.current = () => {
    canAnimateEdges.current = false;
    // A real native grab takes over from manual exposure review; its necessary
    // pickup/landing timeline must not remain paused by the inspection controls.
    setManualReview(false); setPlaying(false);
    const next = automatic.beginGrab(displayedDrawing.current);
    const sequence = next && assetList.find(item => item.id === next.packageId);
    const images = next && imageCache.current[next.packageId];
    if (sequence && images && next) { drawActualFrame(sequence, images, next.exposure); setAsset(sequence); setExposure(next.exposure); }
  };
  // Repaint the current exposure on theme changes, including a paused/static pose.
  // Palette changes do not enter playback, interaction, session or cue identities.
  React.useEffect(() => {
    if (asset) drawActualFrame(asset, pictures, displayedExposure);
  }, [asset, pictures, displayedExposure, automatic.context, automatic.packageId, automatic.exposure, companionWindow.refreshHitMask, accentPalette]);
  const handledWorld = React.useRef(0);
  React.useEffect(() => {
    const event = automatic.worldEvent;
    if (!event || handledWorld.current === event.revision) return;
    if (event.phase !== 'clear') {
      const drawn = assetList.find(item => item.id === displayedDrawing.current?.packageId);
      if (!drawn?.gesture || drawn.gesture.embeddedStool) return;
    }
    handledWorld.current = event.revision; companionWindow.worldStool(event.phase);
  }, [automatic.worldEvent, asset?.id, assetList, displayedExposure, companionWindow.worldStool]);
  React.useEffect(() => {
    if (companionWindow.phase === 'landing' && !automatic.gestureActive) companionWindow.settle();
  }, [automatic.gestureActive, companionWindow.phase]);
  React.useEffect(() => {
    if (!playing || !asset) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches || document.hidden) { setPlaying(false); return; }
    let request = 0, start: number | undefined;
    const stop = () => { if (document.hidden || reduced.matches) setPlaying(false); };
    const draw = (now: number) => {
      start ??= now;
      const elapsed = now - start;
      const index = asset.frames.findIndex(frame => elapsed < frame.startMs + frame.durationMs);
      setExposure(index < 0 ? asset.frames.length - 1 : index);
      if (elapsed < asset.durationMs) request = requestAnimationFrame(draw); else setPlaying(false);
    };
    request = requestAnimationFrame(draw);
    document.addEventListener('visibilitychange', stop); reduced.addEventListener('change', stop);
    return () => { cancelAnimationFrame(request); document.removeEventListener('visibilitychange', stop); reduced.removeEventListener('change', stop); };
  }, [playing, asset]);
  const identity = selected?.generation === generation ? selected.identity : null;
  const focusTitle = identity ? attention.snapshot?.branches.find(branch => branch.threadId === identity.threadId && branch.branchId === identity.branchId)?.title
    || threads.find(thread => thread.thread_id === identity.threadId)?.title : undefined;
  const openThread = (target: ThreadIdentity) => { if (isElectronShell()) void invokeDesktop('desktop_focus_main_window', target).catch(cause => setError(String(cause))); };
  const run = snapshot?.activeRun;
  const pending = snapshot?.operations.filter(operation => operation.phase !== 'terminal') ?? [];
  const unknownEffects = snapshot?.operations.filter(operation => operation.effect === 'unknown') ?? [];
  const statusKeys: Record<string, I18nKey> = { C02: 'companion.activity.accepted', C03: 'companion.activity.preparing', C04: 'companion.activity.thinking', C05: 'companion.activity.output',
    T01: 'companion.activity.reading', T02: 'companion.activity.editing', T03: 'companion.activity.executing', T04: 'companion.activity.searching', T05: 'companion.activity.computing', T06: 'companion.activity.organizing', T07: 'companion.activity.verifying', T08: 'companion.activity.dispatch',
    W01: 'companion.activity.queued', W04: 'companion.activity.external', W05: 'companion.activity.retry', C01: 'companion.idle', C06: 'companion.completed', W02: 'companion.permission', W03: 'companion.question', E01: 'companion.failed', E02: 'companion.cancelling', E04: 'companion.unknown', E05: 'companion.sync', E06: 'companion.uncertain' };
  const shortStatus = health === 'unselected' ? t('companion.quiet') : t(statusKeys[intent.state ?? ''] ?? (run?.state === 'cancelled' ? 'companion.cancelled' : intent.state?.startsWith('W') ? 'companion.waiting' : 'companion.working'));
  const panel: React.CSSProperties = { background: '#20242bed', color: '#edf0f6', borderRadius: 10, padding: 10, font: '12px system-ui', margin: 5 };
  const windowNotice = companionWindow.notice === 'passthrough-unsupported' ? t('companion.passthroughUnsupported') : companionWindow.notice;
  return <main style={{ width: '100%', position: 'relative', background: 'transparent', font: '12px system-ui' }}>
    <style>{`
      .companion-controls button,.companion-controls select{font:inherit;color:inherit;background:#303844;border:1px solid #74839a66;border-radius:8px;padding:6px 10px;min-height:30px;max-width:100%;box-sizing:border-box}
      .companion-controls button{cursor:pointer;margin:3px 6px 3px 0}
      .companion-controls button:hover:not(:disabled){background:#414e61;border-color:#a9c3ec}
      .companion-controls button:disabled{opacity:.45;cursor:default}
      .companion-controls button:focus-visible,.companion-controls select:focus-visible,.companion-controls input:focus-visible{outline:2px solid #a9c3ec;outline-offset:2px}
      .companion-controls label{display:inline-flex;align-items:center;gap:6px;margin:4px 0}
      .companion-controls input[type=checkbox]{accent-color:#a9c3ec}
      .companion-controls select{display:block;width:100%;margin-top:7px}
    `}</style>
    {review ? reviewChrome && <header style={{ ...panel, WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <strong>Varin companion · development review</strong>
      <button style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} onClick={() => { setControlsOpen(false); setAttentionOpen(false); setReviewStageOnly(true); window.scrollTo(0, 0); }}>只看角色/小队</button>
      <button style={{ float: 'right', WebkitAppRegion: 'no-drag' } as React.CSSProperties} disabled={!isElectronShell()}
        onClick={() => void invokeDesktop('desktop_close_current_window')}>Close</button>
    </header> : <button aria-label={t('companion.controls')} aria-expanded={controlsOpen} onClick={() => setControlsOpen(value => !value)} style={{ position: 'absolute', right: 6, top: 6, zIndex: 20, borderRadius: 20, background: '#20242bca', color: 'white', border: 0, padding: '6px 10px' }}>⋯</button>}
    {reviewChrome && <section style={{ ...panel, margin: 0, padding: '4px 8px' }} aria-label="Director review entry">
      <label><input type="checkbox" checked={directorReview} onChange={event => { setDirectorEnabled(event.target.checked); setSelectedReviewEnabled(false); setManualReview(false); setPlaying(false); setFinishedDirectorSentence(null); fixtureSession.discardTransient(); refreshFixture(); }} />主管候选（独立资源，仅开发审阅）</label>
      <label><input type="checkbox" aria-label="Review selected director assets" checked={selectedDirectorReview} onChange={event => { setSelectedReviewEnabled(event.target.checked); setDirectorEnabled(false); setManualReview(false); setPlaying(false); setFinishedDirectorSentence(null); fixtureSession.discardTransient(); refreshFixture(); }} />已选正式资源（仅开发审阅，不开放候选）</label>
      {directorReviewControls && <>
        <label style={{ display: 'block' }}>数据 <select aria-label="Director review data source" value={fixtureMode ? 'fixture' : 'host'} onChange={event => { setFixtureMode(event.target.value === 'fixture'); setFinishedDirectorSentence(null); fixtureSession.discardTransient(); refreshFixture(); }}><option value="host">实际 Host · 只读</option><option value="fixture">Bot统筹演示 fixture · 非真实任务</option></select></label>
        {fixtureActive && <label>演示 <select aria-label="Offline director scenario" value={fixtureStep} onChange={event => selectFixture(event.target.value as DirectorReviewStep)}><option value="portfolio">三项目总览</option><option value="team-active">A/C各自主队与子队</option><option value="a-child-ended">A子队结束 · C子队仍执行</option><option value="b-intake">B新分派已受理</option><option value="b-result">B结果 · A仍执行</option><option value="requests">B授权 · C问题</option><option value="b-resolved">B解除 · C仍待答</option><option value="unknown">观察未知</option><option value="reconnected">恢复观察不重播</option><option value="bot-ready">模拟 · Bot准备就绪</option><option value="bot-reasoning">模拟 · 当前请求推理阶段</option><option value="bot-output">模拟 · 当前请求输出阶段（普通工作）</option><option value="report-delivered">模拟 · 报告已实际送达根任务</option><option value="retry-wait">模拟 · 已安排重试等待（不按时钟假定恢复）</option><option value="queued-successor">模拟 · 后继任务真实排队</option><option value="queue-promoted">模拟 · 排队任务晋升 · 新任务接收</option><option value="executor-stopped">模拟 · 单执行器已停止回执（非全部停止）</option></select></label>}
        <small style={{ display: 'block', color: fixtureActive ? '#ffd393' : undefined }}>{fixtureActive ? '显式Bot协调示例：不写Host，不执行/打开任何示例任务' : '真实Host空列表将保持为空；不生成示例任务'} · {selectedDirectorReview ? '使用已选正式人物包' : '未选择正式人物包'}</small>
      </>}
    </section>}
    {review && reviewStageOnly && <div style={{ position: 'fixed', left: 4, top: 4, zIndex: 30, background: '#20242bd9', color: 'white', padding: '3px 6px', borderRadius: 8, font: '10px system-ui' }}>
      <span>{fixtureActive ? '开发舞台 · 演示任务（非真实执行）' : '开发舞台 · 实际Host只读'}</span> <button ref={restoreReview} onClick={() => setReviewStageOnly(false)} aria-label="恢复开发审阅控件">恢复控件</button>
    </div>}
    <canvas ref={canvas} {...companionWindow.handlers} style={{ width: directorReviewControls && !reviewStageOnly ? 'min(100%,320px)' : 'min(100%,360px)', height: 'auto', margin: 'auto', touchAction: 'none', display: asset ? 'block' : 'none' }} />
    {error && !review && <p role="alert" style={panel}>{error}</p>}
    {!asset && <p style={panel}>{assetList.length ? t('companion.loading') : t('companion.missing')}</p>}
    {directorReviewControls && reviewChrome && <section data-companion-scene-floor style={panel} aria-label="Director candidate portfolio">
      <strong>{selectedDirectorReview ? 'Selected director assets — read-only developer review' : 'Director candidate — read-only project inspection, not final artwork selection'}</strong>
      <p>{selectedDirectorReview ? '已选' : '候选'} {(selectedDirectorReview ? bundledEpoch : reviewBundleIdentity)?.slice(0, 12) || "尚未加载"} · Management: {director.body.verb}. Project execution detail does not select Varin's body.</p>
      <label><input type="checkbox" checked={hideTaskNames} onChange={event => setHideTaskNames(event.target.checked)} />Hide decorative task names</label>
      <div>{portfolioProjection.legend.map(item => <button key={item.key} onClick={() => { if (fixtureActive) { setFixtureInspection(item.identity); setFinishedDirectorSentence(null); refreshFixture(); } else setSelected({ generation, identity: item.identity }); }}>{item.label} · {item.title || 'Untitled task'}</button>)}</div>
      {!assetList.some(item => item.action === 'director-supervise') && <p>Load the explicit complete director candidate bundle to review management performances. No old tool-action fallback is used.</p>}
    </section>}
    {!review && showCompanionAttentionSummary(attention, !!identity) && <section data-companion-scene-floor style={{ ...panel, position: 'fixed', bottom: 3, left: 5, right: 5, margin: 0, maxHeight: 104, overflow: 'auto', boxSizing: 'border-box' }}><CompanionAttentionSummary interactionRoute={director.interactionRoute} directorMode={directorMode} onClearInspection={() => setSelected(null)} attention={attention} focusTitle={focusTitle} focused={!!identity} focusStatus={shortStatus} onInspect={() => { setControlsOpen(false); setAttentionOpen(true); attention.refresh(); }} /></section>}
    {attentionOpen && <div style={{ position: 'fixed', inset: '6px 4px', maxHeight: 'calc(100vh - 12px)', zIndex: 30, overflow: 'auto' }}><CompanionAttentionPanel interactionRoute={director.interactionRoute} directorMode={directorMode} onClearInspection={() => { setSelected(null); setAttentionOpen(false); }} attention={attention} identity={identity} focusTitle={focusTitle} onFocus={target => { setSelected({ generation, identity: target }); setAttentionOpen(false); }} onOpenThread={openThread} onClose={() => setAttentionOpen(false)} onRefresh={attention.refresh} /></div>}
    {(reviewChrome || !review && controlsOpen) && <section className="companion-controls" style={{ ...panel, ...(!review ? { position: 'absolute', top: 40, left: 4, right: 4, zIndex: 20, maxHeight: 140, overflow: 'auto' } as React.CSSProperties : {}) }}><button disabled={!isElectronShell()} onClick={() => void companionWindow.togglePinned()}>{companionWindow.pinned ? t('companion.unpin') : t('companion.pin')}</button><label><input type="checkbox" disabled={!isElectronShell()} checked={companionWindow.passthrough} onChange={event => companionWindow.setPassthrough(event.target.checked)} />{t('companion.passthrough')}</label>{!review && apis.bots && <label style={{ display: 'block' }}>{t('companion.association')}<select aria-label={t('companion.association')} value={productMode === 'bot-coordinator' ? `bot:${associatedBot}` : productMode === 'agent-companion' ? 'agent' : ''} onChange={event => companion.choose(event.target.value.startsWith('bot:') ? event.target.value.slice(4) : null)}>{productMode === 'unknown' && <option value="" disabled>{t('companion.association.unknown')}</option>}{companion.bots.map(bot => <option key={bot.id} value={`bot:${bot.id}`}>{bot.name}</option>)}<option value="agent">{t('companion.association.agent')}</option></select></label>}{directorMode && <><button onClick={() => { setControlsOpen(false); setAttentionOpen(true); attention.refresh(); }}>{t('companion.director.projects')}</button><label><input type="checkbox" checked={hideTaskNames} onChange={event => setHideTaskNames(event.target.checked)} />{t('companion.director.hideTaskNames')}</label></>}{review && <p>Local movement: {companionWindow.phase}. Movement artwork remains gated by accepted lift/landing assets.</p>}{windowNotice && <p role="status">{windowNotice}</p>}{!review && <button disabled={!isElectronShell()} onClick={() => void invokeDesktop('desktop_set_companion', { enabled: false }).catch(cause => setError(String(cause)))}>{t('companion.close')}</button>}</section>}
    {reviewChrome && <section style={panel} aria-label="Development presentation review">
      <label>Preview presentation (not Host state) <select value={presentation} onChange={event => { setPresentation(event.target.value); setReviewRoute(true); setManualReview(false); setPlaying(false); }}>
        {catalog.states.map(state => <option key={state.id} value={state.id} disabled={state.id === 'L04' || state.id === 'L05'}>{state.id} {state.label}{state.id === 'L04' || state.id === 'L05' ? ' · drag/release the character' : ''}</option>)}
      </select></label>
      <small>L04/L05 use actual pointer pickup/release, not a synthetic Host state. E03 previews a neutral recovery pose only; it does not confirm executor stoppage.</small>
      <input type="file" multiple accept=".json,.png" aria-label="Select bundle or sequence JSON and PNG atlases" onChange={event => void loadFiles(event.target.files)} />
      {assetList.length > 1 && <select aria-label="Review an actual package in the bundle" value={asset?.id ?? ''} onChange={event => { setManualReview(true); setPlaying(false); setExposure(0); setAsset(assetList.find(item => item.id === event.target.value)); }}>{asset && asset.kind !== 'action' && <option value={asset.id}>Current transition · {asset.id}</option>}{assetList.filter(item => item.kind === 'action').map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select>}
      {asset && <><p>{asset.id} · {asset.stage ?? 'unstated stage'} · {asset.warning}</p>
        <button onClick={() => { setManualReview(true); setExposure(0); setPlaying(value => !value); }}>{playing ? 'Stop' : 'Replay authored timing'}</button>
        <button onClick={() => { setManualReview(true); setPlaying(false); setExposure(Math.min(asset.frames.length - 1, displayedExposure + 1)); }}>Next exposure</button>
        <span> {displayedExposure + 1}/{asset.frames.length} exposures</span><button onClick={() => { setPlaying(false); setManualReview(false); setReviewRoute(false); }}>Follow actual Host presentation</button></>}
      {error && <p role="alert">{error}</p>}
    </section>}
    {(reviewChrome || !review && controlsOpen && !directorMode) && <section className="companion-controls" style={{ ...panel, ...(!review ? { position: 'absolute', top: windowNotice ? 215 : 145, left: 4, right: 4, zIndex: 20, maxHeight: windowNotice ? 'calc(100vh - 230px)' : 'calc(100vh - 160px)', overflow: 'auto' } as React.CSSProperties : {}) }} aria-label="Actual Host facts">
      <strong>{review ? 'Actual Host facts — independent of review target' : t('companion.observe')}</strong>
      <select aria-label="Observe an existing thread branch" value={identity ? JSON.stringify(identity) : ''} onChange={event => {
        setSelected(event.target.value ? { generation, identity: JSON.parse(event.target.value) as ThreadIdentity } : null);
      }}><option value="">{t('companion.noThread')}</option>{threads.flatMap(thread => thread.branches.map(branch => {
        const value: ThreadIdentity = { runtime: 'agent', threadId: thread.thread_id, branchId: branch.branch_id };
        return <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{thread.title || thread.thread_id} / {branch.branch_id}</option>;
      }))}</select>
      {threadListUnavailable && <p role="status">{t('companion.unavailable')}</p>}
      <p role="status">{review ? connection : health === 'current' ? t('companion.observing') : health === 'unknown' || connection.includes('Error') ? t('companion.unavailable') : t('companion.noThread')}</p>{review && automatic.blocker && <p>Artwork: {automatic.blocker}</p>}{review && <p>Host presentation: {intent.state ?? 'Unclassified execution'} · {intent.reason}</p>}
      {review && snapshot && <p>Run: {run?.state ?? 'No active run'} · cancellation requested: {String(run?.cancel_requested ?? false)} · nonterminal operations: {pending.length} · unknown effects: {unknownEffects.length}</p>}
      <button disabled={!identity || !isElectronShell()} onClick={() => { if (identity) void invokeDesktop('desktop_focus_main_window', identity); }}>{t('companion.openThread')}</button>
      {review && <small>Observation does not create a thread, mark it read, approve, cancel or restart work. Host intent is read-only. Candidate review remains separate; automatic playback requires accepted, compatible artwork.</small>}
    </section>}
  </main>;
}

export function renderCompanionApp(apis: RuntimeAPIs) {
  const root = document.getElementById('root');
  if (!root) throw new Error('Companion root not found');
  initializeLocale();
  createRoot(root).render(<ThemeSystemProvider passiveTransparent><I18nProvider><CompanionApp apis={apis} /></I18nProvider></ThemeSystemProvider>);
}
