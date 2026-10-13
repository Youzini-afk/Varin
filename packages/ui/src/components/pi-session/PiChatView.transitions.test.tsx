import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PiSessionEntry, PiSessionMessageEntry, RecoveryPreference, SessionSnapshot } from '@varin/protocol';
import type { WorkspaceCombinedRecoveryPlan, WorkspaceCombinedRecoveryOperation, WorkspaceRecoveryAPI } from '@varin/extension-contract';
import type { ProjectEntry } from '@varin/application-client';
import type { WorkbenchWorkspaceState } from '@/lib/extensions/workbench-workspace';
import type { PiSessionStoreState, PiSessionViewState } from '@/stores/usePiSessionStore';
import { readPiDraft, usePiDraftStore } from '@/stores/usePiDraftStore';
import { PiChatView } from './PiChatView';
import { WorkbenchShellHost } from '@/lib/extensions/workbench-shell-host';

const mocks = vi.hoisted(() => ({
  state: {} as PiSessionStoreState,
  mounts: 0,
  runtimeEpoch: 1,
  projectId: null as string | null,
  projects: [] as ProjectEntry[],
  directory: '/repo',
  recoveryPreference: 'conversation' as RecoveryPreference,
  recovery: undefined as WorkspaceRecoveryAPI | undefined,
  recover: undefined as ((entry: PiSessionMessageEntry) => void) | undefined,
  home: '/repo',
  workspace: {} as WorkbenchWorkspaceState,
  composer: {} as {
    sessionId: string | null; loading: boolean; placement: string; draft: string;
    effectiveModel?: { id: string }; onChangeDraft(text: string): void;
  },
}));
vi.mock('@/stores/usePiSessionStore', () => {
  const hook = <T,>(selector: (state: PiSessionStoreState) => T) => selector(mocks.state);
  hook.getState = () => mocks.state;
  return { usePiSessionStore: hook, isPiSessionWorkerReady: (record?: PiSessionViewState) => record?.open === true && Boolean(record.snapshot) };
});
vi.mock('@varin/application-client', async (original) => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeKey: () => mocks.state.runtimeKey,
  getRuntimeEndpointGeneration: () => mocks.runtimeEpoch,
}));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (state: unknown) => unknown) => select({ projects: mocks.projects, activeProjectId: mocks.projectId }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: unknown) => unknown) => select({ currentDirectory: mocks.directory, homeDirectory: mocks.home, setDirectory: vi.fn() }) }));
vi.mock('@/stores/messageQueueStore', () => ({ useMessageQueueStore: (select: (state: unknown) => unknown) => select({ followUpBehavior: 'queue' }) }));
vi.mock('@/stores/usePiInteractionStore', () => ({ usePiInteractionStore: (select: (state: unknown) => unknown) => select({ sessions: {} }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({ isTimelineDialogOpen: false, recoveryPreference: mocks.recoveryPreference, setTimelineDialogOpen: vi.fn() }) }));
vi.mock('@/lib/recovery/workspaceRecovery', async original => ({
  ...await original<typeof import('@/lib/recovery/workspaceRecovery')>(),
  getWorkspaceRecoveryAPI: () => { if (!mocks.recovery) throw new Error('Recovery unavailable'); return mocks.recovery; },
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/ui/tooltip', () => ({ TooltipProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/components/ui/VarinLogo', () => ({ VarinLogo: () => null }));
vi.mock('@/components/ui/OverlayScrollbar', () => ({ OverlayScrollbar: () => null }));
vi.mock('@/lib/extensions/workbench-registry', () => ({
  WorkbenchReplacement: ({ fallback, target }: { fallback: React.ReactNode; target: string }) => target === 'workbench.shell' ? <PiChatView /> : fallback,
  WORKBENCH_REPLACEMENT_TARGETS: { shell: 'workbench.shell', chatTimeline: 'timeline', chatComposer: 'composer' },
  useSurfaceRegistrySnapshot: () => ({ visibleContributions: [{ descriptor: { id: 'agent-shell', replacement: { target: 'workbench.shell' } }, owner: { generation: 1 } }] }),
  workbenchContributionInstanceKey: () => 'agent-shell:1',
}));
vi.mock('@/lib/extensions/catalog-store', () => ({ useVarinExtensionCatalog: () => ({ snapshot: { catalog: { hostId: mocks.state.runtimeKey } } }) }));
vi.mock('@/lib/extensions/workbench-workspace', () => ({ useWorkbenchWorkspace: () => mocks.workspace }));
vi.mock('@/lib/extensions/workbench-shell-staging', () => ({ WorkbenchShellStagingHost: () => null }));
vi.mock('@/lib/extensions/workbench-shell-view', () => ({ resolveWorkbenchShellView: () => ({ view: 'ready', resolved: { profileId: 'default', shellContributionId: 'agent-shell' } }) }));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  useIsPresent: () => true,
  motion: { div: React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(({ children, inert, 'aria-hidden': hidden, className }, ref) => (
    <div ref={ref} inert={inert} aria-hidden={hidden} className={className}>{children}</div>
  )) },
}));
vi.mock('./PiComposer', () => ({ PiComposer: (props: typeof mocks.composer & { draft: string }) => {
  mocks.composer = props;
  React.useEffect(() => { mocks.mounts += 1; }, []);
  return <textarea aria-label="draft" value={props.draft} onChange={(event) => props.onChangeDraft(event.target.value)} />;
} }));
vi.mock('./PiTimeline', () => ({ PiTimeline: ({ entries, onRecover }: { entries: PiSessionEntry[]; onRecover: (entry: PiSessionMessageEntry) => void }) => {
  mocks.recover = onRecover;
  return <div data-testid="history">{entries.map(entry => entry.type === 'message' && entry.message.role === 'user' && typeof entry.message.content === 'string' ? entry.message.content : '').join(' ')}</div>;
} }));
vi.mock('./usePiComposerDefaults', () => ({ usePiComposerDefaults: () => ({ loading: false, model: { id: 'default-model', provider: 'test' } }) }));
vi.mock('./usePiMessageHandoff', () => ({ usePiMessageHandoff: () => ({ ref: undefined, captureDraft: vi.fn(), submit: vi.fn(), cancelSubmission: vi.fn() }) }));
vi.mock('./HarnessThreadState', () => ({ HarnessThreadStateProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock('./HarnessThreadConversation', () => ({ HarnessThreadParentLink: () => null }));
vi.mock('./HarnessThreadsPanel', () => ({ HarnessThreadsPanel: () => null }));
vi.mock('./PiAssistBar', () => ({ PiAssistBar: () => null }));
vi.mock('./PiExtensionUiChrome', () => ({ PiExtensionUiChrome: () => null }));
vi.mock('./PiGoalControls', () => ({ PiGoalStrip: () => null }));
vi.mock('./PiFollowUpsStrip', () => ({ PiFollowUpsStrip: () => null }));
vi.mock('./PiComputerActivity', () => ({ PiComputerActivity: () => null }));
vi.mock('./PiRecoveryDialog', () => ({ PiRecoveryDialog: () => null }));
vi.mock('./PiCompactionTraceDialog', () => ({ PiCompactionTraceDialog: () => null }));
vi.mock('./PdfMaterialReader', () => ({ PdfMaterialReader: () => null }));
vi.mock('@/components/chat/DraftPresetChips', () => ({ DraftPresetChips: () => null }));
vi.mock('@/components/chat/AutoReviewBanner', () => ({ AutoReviewBanner: () => null }));

let root: Root;
let container: HTMLDivElement;
const render = () => act(async () => { root.render(<PiChatView />); });
const history = (sessionId: string, text: string): PiSessionViewState => ({
  sessionId, open: false, extensionStates: {}, toolExecutions: {},
  branchEntries: { sessionId, scope: 'branch', leafId: 'entry', entries: [{
    id: 'entry', parentId: null, timestamp: '2026-10-07T00:00:00Z', type: 'message',
    message: { role: 'user', content: text, timestamp: 0 },
  }] },
});

beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.mounts = 0;
  mocks.runtimeEpoch = 1;
  mocks.recoveryPreference = 'conversation'; mocks.recovery = undefined; mocks.recover = undefined;
  mocks.projectId = null;
  mocks.projects = [];
  mocks.directory = '/repo';
  mocks.home = '/repo';
  mocks.workspace = { status: 'ready', workspaceId: 'repo', directory: '/repo', key: 'repo', retry: vi.fn() };
  mocks.state = { runtimeKey: 'host-a', currentSessionId: null, openingSessionId: null,
    summaries: [], records: {}, connectionPhase: 'connected', catalogLoaded: true } as unknown as PiSessionStoreState;
  usePiDraftStore.setState({ drafts: {} });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('keeps one composer through the draft, history and worker phases, with the selected draft owner', async () => {
  usePiDraftStore.getState().setPendingDraft('/repo', { text: 'Unsent new conversation' }, 'host-a');
  await render();
  const input = container.querySelector('textarea');
  expect(mocks.composer.draft).toBe('Unsent new conversation');
  expect(mocks.composer.placement).toBe('center');

  mocks.state.currentSessionId = 'target';
  mocks.state.openingSessionId = 'target';
  usePiDraftStore.getState().setDraft('target', { text: 'Target draft' }, 'host-a');
  await render();
  expect(container.querySelector('textarea')).toBe(input);
  expect(mocks.composer.draft).toBe('Target draft');
  expect(mocks.composer.loading).toBe(true);
  expect(mocks.composer.effectiveModel).toBeUndefined();
  await act(async () => mocks.composer.onChangeDraft('Edited while loading'));
  expect(readPiDraft('target', 'host-a').text).toBe('Edited while loading');

  mocks.state.records.target = history('target', 'Target history');
  await render();
  expect(container.textContent).toContain('Target history');
  expect(mocks.composer.placement).toBe('bottom');
  expect(mocks.composer.loading).toBe(true);
  mocks.state.records.target.open = true;
  mocks.state.records.target.snapshot = { sessionId: 'target', cwd: '/repo', model: { id: 'target-model', provider: 'test' }, thinkingLevel: 'high' } as SessionSnapshot;
  await render();
  expect(mocks.composer.loading).toBe(false);
  expect(mocks.composer.effectiveModel?.id).toBe('target-model');
  expect(mocks.composer.draft).toBe('Edited while loading');
  expect(mocks.mounts).toBe(1);

  mocks.state.currentSessionId = null;
  mocks.state.openingSessionId = null;
  await render();
  expect(container.querySelector('textarea')).toBe(input);
  expect(mocks.composer.draft).toBe('Unsent new conversation');
  expect(mocks.composer.placement).toBe('center');
});

it('retains an inert old scene during navigation and clears it on a runtime change', async () => {
  mocks.state.currentSessionId = 'first';
  mocks.state.records.first = history('first', 'First history');
  await render();
  mocks.state.currentSessionId = 'second';
  mocks.state.openingSessionId = 'second';
  await render();
  expect(container.textContent).toContain('First history');
  expect(container.querySelector('[data-testid="history"]')?.closest('[inert]')).not.toBeNull();
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  mocks.state.records.second = history('second', 'Second history');
  await render();
  expect(container.textContent).toContain('Second history');
  expect(container.textContent).not.toContain('First history');
  expect(container.querySelector('[data-testid="history"]')?.closest('[inert]')).toBeNull();
  mocks.state.runtimeKey = 'host-b';
  mocks.state.records = {};
  await render();
  expect(container.textContent).not.toContain('Second history');
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

it('keeps the chat mounted when leaving a project for a new draft and entering another project', async () => {
  const renderHost = () => act(async () => { root.render(<WorkbenchShellHost fallback={<div role="status">Loading workspace</div>} />); });
  mocks.home = '/home';
  mocks.projects = [{ id: 'project-a', path: '/project-a' }, { id: 'project-b', path: '/project-b' }];
  mocks.projectId = 'project-a';
  mocks.directory = '/project-a';
  mocks.workspace = { ...mocks.workspace, status: 'ready', workspaceId: 'project-a', directory: '/project-a' };
  mocks.state.currentSessionId = 'first';
  mocks.state.records.first = history('first', 'First project history');
  await renderHost();
  const input = container.querySelector('textarea');
  expect(input).not.toBeNull();

  mocks.projectId = null;
  mocks.directory = '/home';
  mocks.state.currentSessionId = null;
  mocks.workspace = { status: 'loading', directory: '/home', key: 'home', retry: vi.fn() };
  usePiDraftStore.getState().setPendingDraft('/home', { text: 'General draft' }, 'host-a');
  await renderHost();
  expect(container.querySelector('textarea')).toBe(input);
  expect(mocks.composer.draft).toBe('General draft');
  expect(mocks.composer.placement).toBe('center');
  mocks.workspace = { ...mocks.workspace, status: 'ready', workspaceId: 'home' };
  await renderHost();

  mocks.projectId = 'project-b';
  mocks.directory = '/project-b';
  mocks.state.currentSessionId = 'second';
  mocks.state.openingSessionId = 'second';
  mocks.workspace = { status: 'loading', directory: '/project-b', key: 'project-b', retry: vi.fn() };
  await renderHost();
  expect(container.querySelector('textarea')).toBe(input);
  mocks.workspace = { ...mocks.workspace, status: 'ready', workspaceId: 'project-b' };
  mocks.state.records.second = history('second', 'Second project history');
  await renderHost();
  expect(container.querySelector('textarea')).toBe(input);
  expect(container.textContent).toContain('Second project history');
  expect(mocks.mounts).toBe(1);

  mocks.projectId = 'project-a';
  mocks.directory = '/project-a';
  mocks.state.currentSessionId = 'first';
  mocks.workspace = { status: 'loading', directory: '/project-a', key: 'project-a', retry: vi.fn() };
  await renderHost();
  expect(container.querySelector('textarea')).toBe(input);
  expect(container.textContent).toContain('First project history');
  expect(mocks.mounts).toBe(1);

  mocks.workspace = { ...mocks.workspace, status: 'error', errorMessage: 'Project resolution failed' };
  await renderHost();
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.textContent).toContain('Project resolution failed');
  mocks.workspace = { ...mocks.workspace, status: 'ready', workspaceId: 'project-a' };
  await renderHost();
  mocks.workspace = { status: 'loading', directory: '/project-b', key: 'project-b', retry: vi.fn() };

  mocks.runtimeEpoch += 1;
  mocks.state.runtimeKey = 'host-b';
  await renderHost();
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.textContent).toContain('Loading workspace');
});

function piRecoveryFixture() {
  mocks.state.currentSessionId = 'pi-original';
  const record = history('pi-original', 'Original Pi message'); record.open = true;
  record.snapshot = { sessionId: 'pi-original', cwd: '/original-root', workspace: { kind: 'workspace', id: 'display-workspace', authorityId: 'pi-owner' } } as SessionSnapshot;
  mocks.state.records['pi-original'] = record;
  const refreshEntries = vi.fn<PiSessionStoreState['refreshEntries']>(async () => record.branchEntries!);
  mocks.state.refreshEntries = refreshEntries;
  const plan: WorkspaceCombinedRecoveryPlan = { id: 'pi-recovery', revision: 'revision', workspaceId: 'pi-owner', conversation: { kind: 'pi', sessionId: 'pi-original' }, entryId: 'entry',
    expectedLeafId: 'entry', targetLeafId: null, removedEntryIds: ['entry'], affectedPaths: ['file.txt'], changedBytes: 4, conflicts: [], coverage: 'ready', uncoveredPaths: [], uncoveredReasons: [], createdAt: '2026-10-12T00:00:00Z' };
  const operation: WorkspaceCombinedRecoveryOperation = { id: plan.id, revision: plan.revision, workspaceId: plan.workspaceId, conversation: plan.conversation, entryId: plan.entryId,
    expectedLeafId: plan.expectedLeafId, targetLeafId: plan.targetLeafId, affectedPathCount: 1, appliedPathCount: 1, state: 'complete', conversationState: 'navigated', fileState: 'restored', createdAt: plan.createdAt, updatedAt: plan.createdAt,
    editorText: 'Recovered Pi draft', editorImages: [{ data: 'original-image', mimeType: 'image/png' }] };
  const prepareCombinedRecovery = vi.fn<WorkspaceRecoveryAPI['prepareCombinedRecovery']>(async () => ({ status: 'ready', plan }));
  const applyCombinedRecovery = vi.fn<WorkspaceRecoveryAPI['applyCombinedRecovery']>(async () => ({ status: 'ready', operation }));
  const getCombinedOperation = vi.fn<WorkspaceRecoveryAPI['getCombinedOperation']>(async () => ({ status: 'ready', operation }));
  const cancelCombinedOperation = vi.fn<WorkspaceRecoveryAPI['cancelCombinedOperation']>(async () => ({ status: 'ready', operation: { ...operation, state: 'aborted', conversationState: 'unchanged', fileState: 'unchanged' } }));
  mocks.recovery = { prepareCombinedRecovery, applyCombinedRecovery, getCombinedOperation, cancelCombinedOperation } as unknown as WorkspaceRecoveryAPI;
  mocks.recoveryPreference = 'both';
  return { plan, operation, refreshEntries, prepareCombinedRecovery, applyCombinedRecovery, getCombinedOperation, cancelCombinedOperation, entry: record.branchEntries!.entries[0] as PiSessionMessageEntry };
}

it('Pi recovery keeps the original session owner in the combined contract and restores its image draft after receipt readback', async () => {
  const f = piRecoveryFixture(); f.applyCombinedRecovery.mockRejectedValueOnce(new Error('Response lost'));
  await render();
  await act(async () => mocks.recover!(f.entry));
  expect(f.prepareCombinedRecovery).toHaveBeenCalledWith({ conversation: { kind: 'pi', sessionId: 'pi-original' }, workspaceId: 'pi-owner', entryId: 'entry' });
  expect(f.getCombinedOperation).toHaveBeenCalledWith('pi-recovery');
  expect(f.refreshEntries).toHaveBeenCalledWith('pi-original');
  expect(readPiDraft('pi-original', 'host-a')).toMatchObject({ text: 'Recovered Pi draft', images: f.operation.editorImages });
});

it.each(['session', 'host'] as const)('Pi recovery does not apply a late file plan after switching %s', async changed => {
  const f = piRecoveryFixture(); let resolve!: (value: Awaited<ReturnType<WorkspaceRecoveryAPI['prepareCombinedRecovery']>>) => void;
  f.prepareCombinedRecovery.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render(); await act(async () => mocks.recover!(f.entry));
  if (changed === 'session') { mocks.state.currentSessionId = 'pi-other'; mocks.state.records['pi-other'] = history('pi-other', 'Other history'); }
  else { mocks.state.runtimeKey = 'host-b'; mocks.runtimeEpoch += 1; }
  await render();
  await act(async () => resolve({ status: 'ready', plan: f.plan }));
  expect(f.applyCombinedRecovery).not.toHaveBeenCalled();
  expect(readPiDraft('pi-original', 'host-a').text).toBe('');
  if (changed === 'host') expect(f.cancelCombinedOperation).not.toHaveBeenCalled();
});
