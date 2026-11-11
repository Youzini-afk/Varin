import { OrganizationDestinationPicker } from './OrganizationDestinationPicker';
import { useHoverPill, useSelectionGlide } from './sidebarHighlights';
import { noteSwitchDirection } from '@/lib/motion/switchDirection';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { isLeadThread } from '@/lib/agent-runtime/threadRole';
import { useBotWorkspaceNavigation } from '@/workbenches/bot/botWorkspaceViews';
import { workKey } from '@/workbenches/bot/botPresentation';
import { useI18n } from '@/lib/i18n';
import { openProjectFiles } from '@/lib/openProjectFiles';
import React from 'react';
import { DndContext, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, useDraggable, useDroppable, DragOverlay, type DragEndEvent, type DragOverEvent } from '@dnd-kit/core';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { ConversationOrganizationContainer, ConversationOrganizationObject, ConversationOrganizationOperation, ConversationOrganizationMetadataResult, ConversationOrganizationQuery } from '@varin/application-client';
import { useConversationOrganization, submitOrganization, refreshConversationOrganization, loadOrganizationPage, readOrganizationActionScope, organizationQueryKey, organizationViewSnapshot } from '@/stores/useConversationOrganizationStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useExternalAgentStore, useExternalAgents } from '@/stores/useExternalAgentStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { startThreadFromNavigation, openThreadFromNavigation, openExternalConversationFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { projectOrganization, organizationObjectKey, organizationContainerPath, nearestOrganizationProject, type OrganizationNode } from './organizationProjection';
import { ConversationOrigin } from './ConversationOrigin';
import { FlipList } from './FlipList';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { HarnessIcon } from '@/components/thread/HarnessIcon';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { iconSpriteData } from '@/components/icon/sprite';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { ProjectCreateDialog } from '@/components/sections/projects/ProjectCreateDialog';
import { ProjectIconImage, PROJECT_ICON_MAP, PROJECT_COLOR_MAP } from '@/lib/projectMeta';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { openBotEntryFor, useBotNavigation } from '@/lib/bots';

type Drop = { parentId: string | null; before: ConversationOrganizationObject | null; label: string };
const viewPreferences = new Map<string, { collapsed: Set<string>; known: Set<string>; focus: string | null }>();
const icons: IconName[] = ['folder', 'stack', 'book', 'briefcase', 'star', 'rocket', 'chat-3', 'lightbulb', 'code'];
const colors = ['', '#64748b', '#2563eb', '#7c3aed', '#db2777', '#b45309', '#15803d'];
const safeIcon = (icon: string | null): IconName => icon && Object.hasOwn(iconSpriteData, icon) ? icon as IconName : 'folder';
const composingKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) return false;
  if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault();
  return true;
};

function DropTarget({ id, drop, children, line = false }: { id: string; drop: Drop; children?: React.ReactNode; line?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id, data: drop });
  return <div ref={setNodeRef} className={cn(line ? 'h-1 rounded transition-colors' : 'rounded-md', isOver && (line ? 'bg-primary' : 'bg-interactive-selection ring-1 ring-primary/60'))}>{children}</div>;
}
function DragRow({ node, pending, children }: { node: OrganizationNode; pending: boolean; children: (handle: React.ReactNode) => React.ReactNode }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: node.key, data: node, disabled: pending });
  return <div ref={setNodeRef} data-flip-key={node.key} className={cn('transition-opacity', (isDragging || pending) && 'opacity-45')} aria-busy={pending || undefined}>
    {children(<button type="button" {...attributes} {...listeners} className="shrink-0 rounded p-1 text-muted-foreground opacity-50 hover:opacity-100 focus-visible:opacity-100" aria-label={t('organization.drag')}><Icon name="draggable" className="size-3" /></button>)}
  </div>;
}
export interface ConversationOrganizationTreeProps { query?: string; archived?: boolean; botId?: string; flat?: boolean; viewKey?: string; showRoot?: boolean; stickyHeaders?: boolean; sortOrder?: 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent'; expansion?: { revision: number; expanded: boolean }; selectionMode?: boolean; onExitSelection?(): void; onNavigate?(): void }
export function ConversationOrganizationTree({ query = '', archived = false, botId, flat = false, viewKey = 'workbench', showRoot = true, stickyHeaders = false, sortOrder = 'manual', expansion, selectionMode = false, onExitSelection, onNavigate }: ConversationOrganizationTreeProps) {
  const { t } = useI18n();
  useExternalAgents();
  const state = useConversationOrganization();
  const botWorkspace = useBotWorkspaceNavigation();
  const apis = useRuntimeAPIs();
  const projects = useProjectsStore(s => s.projects);
  const threads = useThreadStore(s => s.threads);
  const botEntry = useBotNavigation(s => s.entry);
  const selected = useThreadStore(s => s.selectedIdentity);
  const externalChildren = useExternalAgentStore(s => s.children);
  const external = useExternalAgentStore(s => s.conversations);
  const externalSelected = useExternalAgentStore(s => s.selectedId);
  const snapshot = state.host === getRuntimeEndpointGeneration() ? state.snapshot : null;
  const prefKey = `${state.host}:${viewKey}`;
  const [preference, setPreference] = React.useState(() => ({ key: prefKey, initialized: viewPreferences.has(prefKey), ...(viewPreferences.get(prefKey) ?? { collapsed: new Set<string>(), known: new Set<string>(), focus: null }) }));
  const savedPrefs = React.useMemo(() => preference.key === prefKey ? preference : { key: prefKey, initialized: false, collapsed: new Set<string>(), known: new Set<string>(), focus: null }, [preference, prefKey]);
  const knownKeys = new Set([...(snapshot?.containers ?? []).map(c => organizationObjectKey({ kind: 'container', id: c.id })), ...(snapshot?.conversations ?? []).map(e => organizationObjectKey(e.conversation))]);
  const prefs = { ...savedPrefs, collapsed: new Set([...savedPrefs.collapsed, ...[...knownKeys].filter(key => !savedPrefs.known.has(key))]) };
  const updatePrefs = (patch: Partial<typeof prefs>) => { const next = { ...prefs, collapsed: prefs.initialized ? prefs.collapsed : new Set([...(snapshot?.containers ?? []).map(c => organizationObjectKey({ kind: 'container', id: c.id })), ...(snapshot?.conversations ?? []).map(e => organizationObjectKey(e.conversation))]), ...patch, known: knownKeys, initialized: true }; viewPreferences.set(prefKey, next); setPreference(next); };
  const selectionTargets = React.useRef(new Map<string, OrganizationNode>());
  const [selection, setSelection] = React.useState<Set<string>>(new Set());
  const [editor, setEditor] = React.useState<{ id: string; container?: ConversationOrganizationContainer; parentId: string | null; name: string; icon: string; color: string } | null>(null);
  const [projectCreate, setProjectCreate] = React.useState<{ parentId: string | null } | null>(null);
  const [newBotId, setNewBotId] = React.useState('');
  const [undo, setUndo] = React.useState<Extract<ConversationOrganizationOperation, { action: 'restore' }>['items'] | null>(null);
  const [movingBusy, setMovingBusy] = React.useState(false);
  const [move, setMove] = React.useState<OrganizationNode[] | null>(null);
  const [moving, setMoving] = React.useState<string>('');
  const [drag, setDrag] = React.useState<OrganizationNode | null>(null);
  const [dropLabel, setDropLabel] = React.useState('');
  const [rename, setRename] = React.useState<{ node: OrganizationNode; title: string } | null>(null);
  const [metadataResults, setMetadataResults] = React.useState<ConversationOrganizationMetadataResult[]>([]);
  const [metadataPending, setMetadataPending] = React.useState(false);
  const [metadataRetry, setMetadataRetry] = React.useState<Parameters<NonNullable<typeof apis.conversationOrganization>['metadata']>[0] | null>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const activePanel = botWorkspace?.views.find(view => view.key === botWorkspace.activeKey);
  const selectedObject = viewKey === 'bot' ? activePanel?.kind === 'work' ? { kind: 'native' as const, id: activePanel.identity.threadId } : activePanel?.kind === 'external' ? { kind: 'external' as const, id: activePanel.id } : botEntry ? { kind: 'native' as const, id: botEntry.threadId } : null : selected ? { kind: 'native' as const, id: selected.threadId } : externalSelected ? { kind: 'external' as const, id: externalSelected } : null;
  useSelectionGlide(list, selectedObject ? organizationObjectKey(selectedObject) : null);
  useHoverPill(list);
  React.useEffect(() => { setSelection(new Set()); setUndo(null); setMovingBusy(false); setEditor(null); setMove(null); setRename(null); setMetadataResults([]); setMetadataRetry(null); setMetadataPending(false); setProjectCreate(null); setNewBotId(''); setMoving(''); selectionTargets.current.clear(); }, [state.host, apis.conversationOrganization]);
  const namedSnapshot = React.useMemo(() => snapshot ? { ...snapshot, containers: snapshot.containers.map(c => c.kind === 'project' ? { ...c, name: projects.find(p => p.id === c.projectId)?.label || projects.find(p => p.id === c.projectId)?.path || t('organization.missingProject', { id: c.projectId ?? '' }) } : c) } : null, [snapshot, projects, t]);
  const scopeQuery = React.useMemo<ConversationOrganizationQuery>(() => ({ pageNodes: true, archived: archived ? 'only' : 'exclude', ...(botId ? { botId, recursive: true } : {}), ...(query.trim() ? { query: query.trim(), recursive: true } : !botId ? { rootOnly: true } : {}) }), [archived, botId, query]);
  React.useEffect(() => { void loadOrganizationPage(scopeQuery); }, [scopeQuery, state.host]);
  const containerQuery = React.useCallback((containerId: string): ConversationOrganizationQuery => ({ pageNodes: true, containerId, archived: archived ? 'only' : 'exclude', ...(botId ? { botId } : {}) }), [archived, botId]);
  const viewQuery = React.useMemo(() => prefs.focus && !query.trim() ? containerQuery(prefs.focus) : scopeQuery, [prefs.focus, query, containerQuery, scopeQuery]);
  React.useEffect(() => { void loadOrganizationPage(viewQuery); }, [viewQuery, state.host]);
  const visibleSnapshot = React.useMemo(() => organizationViewSnapshot(state.pages, viewQuery, id => { const key = organizationObjectKey({ kind: 'container', id }); return savedPrefs.initialized && savedPrefs.known.has(key) && !savedPrefs.collapsed.has(key); }), [state.pages, viewQuery, savedPrefs]);
  const namedVisibleSnapshot = React.useMemo(() => visibleSnapshot ? { ...visibleSnapshot, containers: visibleSnapshot.containers.map(c => namedSnapshot?.containers.find(named => named.id === c.id) ?? c) } : null, [visibleSnapshot, namedSnapshot]);
  const roots = React.useMemo(() => {
    if (!namedVisibleSnapshot) return [];
    const nodes = projectOrganization(namedVisibleSnapshot, { query, archived, botId, flat });
    const byProject = new Map(projects.map(project => [project.id, project]));
    const times = new Map([...threads.map(thread => [organizationObjectKey({ kind: 'native', id: thread.thread_id }), thread.updated_at_ms] as const), ...external.map(c => [organizationObjectKey({ kind: 'external', id: c.id }), c.updatedAt] as const)]);
    const latestCache = new Map<string, number>();
    const latest = (node: OrganizationNode): number => { const cached = latestCache.get(node.key); if (cached !== undefined) return cached; const value = node.children.reduce((value, child) => Math.max(value, latest(child)), times.get(node.key) ?? 0); latestCache.set(node.key, value); return value; };
    const sort = (items: OrganizationNode[]): OrganizationNode[] => {
      const containers = items.filter(node => node.container);
      if (sortOrder !== 'manual') containers.sort((a, b) => {
        if (sortOrder === 'a-z' || sortOrder === 'z-a') return (a.container?.name ?? '').localeCompare(b.container?.name ?? '', undefined, { numeric: true }) * (sortOrder === 'z-a' ? -1 : 1);
        if (sortOrder === 'recent') return latest(b) - latest(a);
        return (byProject.get(b.container?.projectId ?? '')?.addedAt ?? 0) - (byProject.get(a.container?.projectId ?? '')?.addedAt ?? 0);
      });
      let index = 0;
      return items.map(node => node.container ? containers[index++] : node).map(node => ({ ...node, children: sort(node.children) }));
    };
    return sort(nodes.filter(node => showRoot || query.trim() || node.container));
  }, [namedVisibleSnapshot, query, archived, botId, flat, projects, threads, external, sortOrder, showRoot]);
  const expandedRevision = React.useRef(0);
  React.useEffect(() => {
    if (!snapshot || !expansion || expansion.revision === expandedRevision.current) return;
    expandedRevision.current = expansion.revision;
    const collapsed = new Set<string>();
    if (!expansion.expanded) { for (const c of snapshot.containers) collapsed.add(organizationObjectKey({ kind: 'container', id: c.id })); for (const entry of snapshot.conversations) collapsed.add(organizationObjectKey(entry.conversation)); }
    const next = { key: prefKey, initialized: true, collapsed, known: new Set([...(snapshot.containers).map(c => organizationObjectKey({ kind: 'container', id: c.id })), ...snapshot.conversations.map(e => organizationObjectKey(e.conversation))]), focus: null }; viewPreferences.set(prefKey, next); setPreference(next);
  }, [snapshot, expansion, prefKey]);
  const nodes = new Map<string, OrganizationNode>();
  const walk = (items: OrganizationNode[]) => { for (const node of items) { nodes.set(node.key, node); walk(node.children); } }; walk(roots);
  const focused = prefs.focus ? nodes.get(organizationObjectKey({ kind: 'container', id: prefs.focus })) : null;
  const shown = focused ? focused.children : roots;
  const openedContainers: string[] = [];
  const collectOpened = (items: OrganizationNode[]) => { for (const node of items) { const expanded = prefs.initialized && !prefs.collapsed.has(node.key); if (expanded) { if (node.container) openedContainers.push(node.container.id); collectOpened(node.children); } } };
  if (!query.trim()) { if (focused?.container) openedContainers.push(focused.container.id); collectOpened(shown); }
  const openedKey = JSON.stringify(openedContainers);
  React.useEffect(() => { for (const id of JSON.parse(openedKey) as string[]) void loadOrganizationPage(containerQuery(id)); }, [openedKey, containerQuery, state.host]);
  const pageControls = (pageQuery: ConversationOrganizationQuery): React.ReactNode => {
    const page = state.pages[organizationQueryKey(pageQuery)];
    return <>{page?.loading && <p role="status" className="px-2 py-1 typography-micro text-muted-foreground">{t('common.loading')}</p>}{page?.error && <p role="alert" className="px-2 typography-micro text-destructive">{page.error}<Button variant="ghost" size="sm" onClick={() => act(() => refreshConversationOrganization())}>{t('common.retry')}</Button></p>}{page?.snapshot?.nextCursor && <Button variant="ghost" size="sm" onClick={() => act(() => loadOrganizationPage(pageQuery, true))}>{t('organization.loadMore')}</Button>}</>;
  };

  const pendingObjects = new Set(Object.values(state.pending).flatMap(command => command.operation.action === 'move' || command.operation.action === 'restore' ? command.operation.items.map(item => organizationObjectKey(item.object)) : command.operation.action === 'create' ? [] : [organizationObjectKey({ kind: 'container', id: command.operation.id })]));
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }), useSensor(KeyboardSensor));
  const act = (work: () => Promise<unknown>) => { void work().catch(error => toast.error(error instanceof Error ? error.message : String(error))); };
  const parents = (ids: (string | null)[]) => [...new Set(ids)].map(containerId => ({ containerId, childrenRevision: containerId ? snapshot!.containers.find(c => c.id === containerId)!.childrenRevision : snapshot!.rootRevision }));
  const command = (operation: ConversationOrganizationOperation) => submitOrganization(operation);
  const moveNodes = async (items: OrganizationNode[], drop: Drop) => {
    if (!snapshot || !items.length || movingBusy) return;
    const host = state.host; setMovingBusy(true);
    try {
      // The explicit move captures real sibling anchors for undo, including unread pages.
      const originalParents = [...new Set(items.map(node => node.parentId))];
      const originalScopes = await Promise.all(originalParents.map(parentId => readOrganizationActionScope({ ...(parentId ? { containerId: parentId } : { rootOnly: true }), archived: 'include' })));
      if (host !== getRuntimeEndpointGeneration()) return;
      // Never apply anchors from a changed parent or silently upgrade the selected object's CAS.
      for (const node of items) if (!originalScopes.some(scope => node.container ? scope.items?.some(item => item.kind === 'container' && item.id === node.object.id) ?? scope.containers.some(container => container.id === node.object.id) : scope.conversations.some(entry => organizationObjectKey(entry.conversation) === node.key))) throw new Error(t('organization.scopeChanged'));
      for (const scope of originalScopes) {
        for (const node of items) {
          const current = node.container ? scope.containers.find(container => container.id === node.object.id) : scope.conversations.find(entry => organizationObjectKey(entry.conversation) === node.key);
          if (!current) continue;
          const revision = 'position' in current ? current.position.revision : current.revision;
          const parentId = 'position' in current ? current.position.containerId : current.parentId;
          if (revision !== (node.container?.revision ?? node.conversation!.position.revision) || parentId !== node.parentId) throw new Error(t('organization.scopeChanged'));
        }
      }
      for (const parentId of [...new Set(items.map(node => node.parentId))]) {
        const scope = originalScopes[originalParents.indexOf(parentId)]!;
        const revision = parentId ? scope.containers.find(container => container.id === parentId)?.childrenRevision : scope.rootRevision;
        const expected = parentId ? snapshot.containers.find(container => container.id === parentId)?.childrenRevision : snapshot.rootRevision;
        if (revision === undefined || revision !== expected) throw new Error(t('organization.scopeChanged'));
      }
      const receipt = await command({ action: 'move', items: items.map(n => ({ object: n.object, expectedRevision: n.container?.revision ?? n.conversation!.position.revision, expectedParentId: n.parentId })), parentId: drop.parentId, before: drop.before, parents: parents([...items.map(n => n.parentId), drop.parentId]) });
      if (host !== getRuntimeEndpointGeneration()) return;
      if (receipt) {
        const selectedKeys = new Set(items.map(node => node.key));
        const inverse: Extract<ConversationOrganizationOperation, { action: 'restore' }>['items'] = [];
        for (const parentId of [...new Set(items.map(node => node.parentId))]) {
          const siblings = new Map<string, { object: ConversationOrganizationObject; order: number }>();
          for (const scope of originalScopes) {
            for (const container of scope.containers) if (container.parentId === parentId) { const object = { kind: 'container' as const, id: container.id }; siblings.set(organizationObjectKey(object), { object, order: container.order }); }
            for (const entry of scope.conversations) if (entry.position.containerId === parentId && !entry.position.inheritedFrom) siblings.set(organizationObjectKey(entry.conversation), { object: entry.conversation, order: entry.position.order });
          }
          const ordered = [...siblings.values()].sort((a, b) => a.order - b.order || organizationObjectKey(a.object).localeCompare(organizationObjectKey(b.object)));
          for (const node of items.filter(node => node.parentId === parentId).sort((a, b) => a.order - b.order)) {
            const original = originalScopes.flatMap(scope => scope.conversations).find(entry => organizationObjectKey(entry.conversation) === node.key);
            const inherit = Boolean(original && !original.position.explicit && original.position.inheritedFrom);
            const index = ordered.findIndex(item => organizationObjectKey(item.object) === node.key);
            if (!inherit && index < 0) throw new Error(t('organization.scopeChanged'));
            const before = inherit ? null : ordered.slice(index + 1).find(item => !selectedKeys.has(organizationObjectKey(item.object)))?.object ?? null;
            const position = receipt.positions.find(position => organizationObjectKey(position.conversation) === node.key);
            const container = receipt.containers.find(container => node.object.kind === 'container' && container.id === node.object.id);
            if (!position && !container) throw new Error('Move receipt did not include the moved object');
            inverse.push({ object: node.object, expectedRevision: container?.revision ?? position!.revision, expectedParentId: container?.parentId ?? position?.containerId ?? null, parentId, before, inherit });
          }
        }
        setUndo(inverse);
      }
      setMove(null); setSelection(new Set());
    } finally { if (host === getRuntimeEndpointGeneration()) setMovingBusy(false); }
  };
  const undoMove = async () => {
    if (!undo) return;
    // Expected object revisions come from our receipt, never a newer client's movement.
    await command({ action: 'restore', items: undo, parents: parents(undo.flatMap(item => [item.expectedParentId, item.parentId])) });
    setUndo(null);
  };
  const allNodes = new Map<string, OrganizationNode>([...(snapshot?.containers ?? []).map(container => ({ key: organizationObjectKey({ kind: 'container', id: container.id }), object: { kind: 'container' as const, id: container.id }, parentId: container.parentId, order: container.order, container, children: [] })), ...(snapshot?.conversations ?? []).map(conversation => ({ key: organizationObjectKey(conversation.conversation), object: conversation.conversation, parentId: conversation.position.containerId, order: conversation.position.order, conversation, children: [] }))].map(node => [node.key, node]));
  const selectedNodes = [...selection].flatMap(key => allNodes.get(key) ?? selectionTargets.current.get(key) ?? []);
  const onDragEnd = (event: DragEndEvent) => {
    const node = event.active.data.current as OrganizationNode | undefined;
    const drop = event.over?.data.current as Drop | undefined;
    setDrag(null); setDropLabel('');
    if (node && drop) act(() => moveNodes(selection.has(node.key) ? selectedNodes : [node], drop));
  };
  const onDragOver = (event: DragOverEvent) => setDropLabel((event.over?.data.current as Drop | undefined)?.label ?? '');
  const create = (parentId: string | null) => setEditor({ id: crypto.randomUUID(), parentId, name: '', icon: 'folder', color: '' });
  const newConversation = (containerId: string | null) => act(async () => {
    const projectId = nearestOrganizationProject(snapshot!, containerId);
    const project = projects.find(p => p.id === projectId);
    await startThreadFromNavigation({ directory: project?.path, projectId: projectId ?? undefined, organization: { containerId }, ...(botId || newBotId ? { botId: botId || newBotId } : {}) });
    onNavigate?.();
  });
  const metadata = async (items: OrganizationNode[], patch: { archived?: boolean; deleted?: boolean; pinned?: boolean; title?: string }, retry = false) => {
    if (!apis.conversationOrganization || metadataPending) return;
    if (state.host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed');
    const requestedItems = items.flatMap(n => n.conversation ? [{ conversation: n.conversation.conversation, expectedRevision: n.conversation.revision, patch }] : []);
    const input = metadataRetry && (retry || JSON.stringify(metadataRetry.items) === JSON.stringify(requestedItems)) ? metadataRetry : { key: crypto.randomUUID(), items: requestedItems };
    if (!input.items.length) return;
    const host = state.host;
    setMetadataPending(true); setMetadataRetry(input);
    try {
      const result = await apis.conversationOrganization.metadata(input);
      if (host !== getRuntimeEndpointGeneration()) return;
      setMetadataResults(result.items);
      const unresolved = new Set(result.items.filter(i => i.status !== 'succeeded').map(i => organizationObjectKey(i.conversation)));
      setMetadataRetry(unresolved.size ? { ...input, items: input.items.filter(i => unresolved.has(organizationObjectKey(i.conversation))) } : null);
      await refreshConversationOrganization(); await useThreadStore.getState().loadCatalog(); await useExternalAgentStore.getState().refresh();
    } finally { if (host === getRuntimeEndpointGeneration()) setMetadataPending(false); }
  };
  const archiveContainer = async (containerId: string, recursive: boolean) => {
    const scope = await readOrganizationActionScope({ containerId, recursive, archived: archived ? 'only' : 'exclude' });
    await metadata(scope.conversations.map(conversation => ({ key: organizationObjectKey(conversation.conversation), object: conversation.conversation, parentId: conversation.position.containerId, order: conversation.position.order, conversation, children: [] })), { archived: !archived });
  };
  const name = (n: OrganizationNode) => n.container?.name ?? n.conversation?.title ?? t('organization.untitled');
  const threadById = new Map(threads.map(thread => [thread.thread_id, thread]));
  const externalById = new Map(external.map(conversation => [conversation.id, conversation]));
  const delegationById = new Map(externalChildren.map(child => [child.conversationId, child]));
  const render = (node: OrganizationNode): React.ReactNode => {
    const entry = node.conversation, container = node.container;
    const project = container?.kind === 'project' ? projects.find(p => p.id === container.projectId) : undefined;
    const projectFallback = <Icon name={project?.icon && PROJECT_ICON_MAP[project.icon] || 'folder-open'} className="size-4 shrink-0" style={{ color: project?.color ? PROJECT_COLOR_MAP[project.color] : undefined }} />;
    const title = name(node), expanded = Boolean(query.trim()) || prefs.initialized && !prefs.collapsed.has(node.key);
    const thread = entry?.conversation.kind === 'native' ? threadById.get(node.object.id) : undefined;
    const ext = entry?.conversation.kind === 'external' ? externalById.get(node.object.id) : undefined;
    const panelView = botWorkspace?.views.find(view => view.key === botWorkspace.activeKey);
    const active = entry && (viewKey === 'bot' ? (entry.origin.directBotId ? botEntry?.threadId === node.object.id : panelView?.kind === 'work' ? panelView.identity.threadId === node.object.id : panelView?.kind === 'external' && panelView.id === node.object.id) : node.object.kind === 'native' ? selected?.threadId === node.object.id : externalSelected === node.object.id);
    const pathLabel = entry && namedSnapshot ? organizationContainerPath(namedSnapshot, entry.position.containerId).map(c => c.name).join(' / ') : '';
    const originatingTitle = entry?.origin.conversation ? snapshot?.conversations.find(c => organizationObjectKey(c.conversation) === organizationObjectKey(entry.origin.conversation!))?.title ?? (entry.origin.conversation.kind === 'native' ? threadById.get(entry.origin.conversation.id)?.title : externalById.get(entry.origin.conversation.id)?.title) : null;
    const open = () => entry ? act(async () => {
      const rows = [...(list.current?.querySelectorAll('[data-sidebar-row]') ?? [])]; const from = rows.findIndex(row => row.getAttribute('data-current') === 'true'); const to = rows.findIndex(row => row.getAttribute('data-sidebar-row') === node.key); noteSwitchDirection(from >= 0 && to >= 0 ? to - from : 0);
      if (viewKey === 'bot' && botWorkspace && !entry.origin.directBotId) {
        if (entry.conversation.kind === 'external') botWorkspace.open({ kind: 'external', key: `external:${entry.conversation.id}`, id: entry.conversation.id, title });
        else { const { identity } = await useThreadStore.getState().resolveThread({ threadId: entry.conversation.id }); botWorkspace.open({ kind: 'work', key: workKey(identity), identity, title }); }
        return;
      }
      await (entry.conversation.kind === 'native' ? openThreadFromNavigation({ threadId: node.object.id }) : openExternalConversationFromNavigation(node.object.id)); onNavigate?.(); }) : updatePrefs({ focus: node.object.id });
    const toggle = () => { if (query.trim()) return; const collapsed = new Set(prefs.initialized ? prefs.collapsed : allNodes.keys()); if (expanded) collapsed.add(node.key); else collapsed.delete(node.key); updatePrefs({ collapsed }); };
    return <React.Fragment key={node.key}>
      <DropTarget id={`before:${node.key}`} line drop={{ parentId: node.parentId, before: node.object, label: t('organization.moveBefore', { name: title }) }} />
      <DragRow node={node} pending={pendingObjects.has(node.key)}>{handle => <DropTarget id={`inside:${node.key}`} drop={{ parentId: container?.id ?? node.parentId, before: null, label: t('organization.moveInside', { name: container ? title : t('organization.category') }) }}>
        <div role="treeitem" data-sidebar-row={node.key} data-current={active || undefined} aria-expanded={node.children.length || container ? expanded : undefined} aria-selected={selection.has(node.key) || Boolean(active)} tabIndex={0} className={cn('group flex min-h-9 items-center gap-1 rounded-md px-1 typography-ui-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', active || selection.has(node.key) ? 'bg-interactive-selection' : 'hover:bg-interactive-hover', stickyHeaders && container && 'sticky top-0 z-10 bg-sidebar/95 backdrop-blur-sm')}
          onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter') open(); if (event.key === 'ArrowRight' && !expanded || event.key === 'ArrowLeft' && expanded) { event.preventDefault(); toggle(); } if (event.key === ' ' && event.ctrlKey) { event.preventDefault(); setSelection(previous => { selectionTargets.current.set(node.key, node); const next = new Set(previous); if (next.has(node.key)) next.delete(node.key); else next.add(node.key); return next; }); } if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const rows = [...(list.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].filter(row => !row.closest('[inert]')); rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus(); } }}>
          <button type="button" className="w-4 shrink-0" aria-label={expanded ? t('organization.collapse', { name: title }) : t('organization.expand', { name: title })} onClick={toggle} disabled={Boolean(query.trim()) || !node.children.length && !container}><Icon name="arrow-right-s" className={cn('size-3 transition-transform duration-200', expanded && 'rotate-90', !node.children.length && !container && 'invisible')} /></button>
          {(selection.size > 0 || selectionMode) && <input type="checkbox" aria-label={t('organization.selectName', { name: title })} checked={selection.has(node.key)} onChange={() => setSelection(previous => { selectionTargets.current.set(node.key, node); const next = new Set(previous); if (next.has(node.key)) next.delete(node.key); else next.add(node.key); return next; })} />}
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left" onClick={open} title={title}>
            {project ? <span className="size-4 shrink-0 overflow-hidden rounded-sm" style={{ backgroundColor: project.iconBackground || undefined }}><ProjectIconImage project={project} className="size-4 object-contain" fallback={projectFallback} /></span> : container ? <Icon name={safeIcon(container.icon)} className="size-4 shrink-0" style={{ color: container.color || undefined }} /> : entry?.origin.directBotId ? <ConversationOrigin origin={entry.origin} main /> : ext ? ext.parent ? <AgentAvatar identity={node.object.id} avatar={delegationById.get(node.object.id)?.avatar} size={20} /> : <HarnessIcon harness={ext.harness} /> : <AgentAvatar identity={node.object.id} avatar={thread?.avatar} size={20} {...(thread && isLeadThread(thread, threadById) ? { role: 'lead' as const } : {})} />}
            <span className="min-w-0 flex-1"><span className="block truncate">{title}</span>{entry && (flat || query.trim()) && <span className="block truncate typography-micro text-muted-foreground" title={[pathLabel, originatingTitle].filter(Boolean).join(' · ')}>{[pathLabel, originatingTitle].filter(Boolean).join(' · ')}</span>}</span>
            {thread?.unread && !active && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label={t('sessions.sidebar.session.status.unread')} />}
            {entry?.pinned && <Icon name="pushpin" className="size-3 shrink-0 text-muted-foreground" />}
            {(thread?.branches.some(b => b.active_run_id) || ext?.activeTurn) && <Icon name="loader-4" className="size-3 animate-spin" />}
          </button>
          {entry && <ConversationOrigin origin={entry.origin} />}
          {project && <ProjectActionsButton projectRef={{ id: project.id, path: project.path, resourceOwner: project.source?.resourceOwner, source: project.source, versionedWorkspace: project.versionedWorkspace }} directory={project.path} compact allowMobile />}
          {handle}
          <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label={t('organization.actions', { name: title })} className="shrink-0 rounded p-1 hover:bg-interactive-hover"><Icon name="more" className="size-4" /></button></DropdownMenuTrigger><DropdownMenuContent>
            {container && <><DropdownMenuItem onClick={() => newConversation(container.id)}>{t('organization.newConversation')}</DropdownMenuItem><DropdownMenuItem onClick={() => create(container.id)}>{t('organization.newGroupMenu')}</DropdownMenuItem><DropdownMenuItem onClick={() => setProjectCreate({ parentId: container.id })}>{t('organization.addProject')}</DropdownMenuItem><DropdownMenuItem onClick={() => updatePrefs({ focus: container.id })}>{t('organization.enter')}</DropdownMenuItem>{container.kind === 'group' ? <DropdownMenuItem onClick={() => setEditor({ id: container.id, container, parentId: container.parentId, name: container.name ?? '', icon: container.icon ?? 'folder', color: container.color ?? '' })}>{t('organization.editGroup')}</DropdownMenuItem> : <><>{project && <DropdownMenuItem onClick={() => act(async () => { if (botWorkspace && viewKey === 'bot') botWorkspace.files(project.source?.resourceOwner ?? { kind: 'local' }, project.label || project.path, undefined, project.path); else { await openProjectFiles(project); onNavigate?.(); } })}>{t('organization.projectFiles')}</DropdownMenuItem>}</><DropdownMenuItem onClick={() => { const ui = useUIStore.getState(); ui.setSettingsProjectsSelectedId(container.projectId); ui.setSettingsPage('projects'); ui.setSettingsDialogOpen(true); onNavigate?.(); }}>{t('organization.projectSettings')}</DropdownMenuItem><DropdownMenuItem onClick={() => act(async () => { await useProjectsStore.getState().removeProject(container.projectId!); await refreshConversationOrganization(); })}>{t('organization.removeProject')}</DropdownMenuItem></>}</>}
            {container && <><DropdownMenuItem onClick={() => act(() => archiveContainer(container.id, false))}>{t(archived ? 'organization.restoreDirect' : 'organization.archiveDirect')}</DropdownMenuItem><DropdownMenuItem onClick={() => act(() => archiveContainer(container.id, true))}>{t(archived ? 'organization.restoreDescendants' : 'organization.archiveDescendants')}</DropdownMenuItem></>}
            <DropdownMenuItem onClick={() => { setMove(selection.has(node.key) ? selectedNodes : [node]); setMoving(node.parentId ?? ''); }}>{t('organization.moveTo')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { selectionTargets.current.set(node.key, node); setSelection(new Set([...selection, node.key])); }}>{t('organization.select')}</DropdownMenuItem>
            {entry && <>{entry.origin.conversation && <DropdownMenuItem onClick={() => act(() => entry.origin.conversation!.kind === 'native' ? openThreadFromNavigation({ threadId: entry.origin.conversation!.id }) : openExternalConversationFromNavigation(entry.origin.conversation!.id))}>{t('organization.origin')}</DropdownMenuItem>}<DropdownMenuItem onClick={() => setRename({ node, title })}>{t('organization.rename')}</DropdownMenuItem><DropdownMenuItem onClick={() => act(() => metadata([node], { pinned: !entry.pinned }))}>{entry.pinned ? t('organization.unpin') : t('organization.pin')}</DropdownMenuItem><DropdownMenuItem onClick={() => act(() => metadata([node], { archived: !entry.archived }))}>{entry.archived ? t('organization.restoreConversation') : t('organization.archiveConversation')}</DropdownMenuItem>{entry.origin.directBotId && <DropdownMenuItem onClick={() => act(() => openBotEntryFor(entry.origin.directBotId!))}>{t('organization.botProfile')}</DropdownMenuItem>}<DropdownMenuItem onClick={() => act(() => metadata([node], { deleted: true }))}>{t('organization.deleteConversation')}</DropdownMenuItem></>}
            {thread && <>{thread.branches.length > 1 && <><DropdownMenuSeparator />{thread.branches.map((branch, index) => <DropdownMenuItem key={branch.branch_id} onClick={() => act(() => openThreadFromNavigation({ threadId: thread.thread_id, branchId: branch.branch_id }))}>{branch.branch_id === thread.main_branch_id ? t('thread.sidebar.mainBranch') : t('thread.sidebar.branch', { number: index + 1 })}</DropdownMenuItem>)}</>}{!thread.parent_thread_id && thread.title_mode === 'manual' && <DropdownMenuItem onClick={() => act(() => useThreadStore.getState().updateThread(thread.thread_id, { titleMode: 'automatic' }))}>{t('sessions.sidebar.session.menu.resumeTitles')}</DropdownMenuItem>}{canUseElectronDesktopIPC() && <DropdownMenuItem onClick={() => act(() => invokeDesktop('desktop_open_thread_mini_chat_window', { threadId: thread.thread_id, branchId: thread.main_branch_id }))}>{t('sessions.sidebar.session.menu.openMiniChatWindow')}</DropdownMenuItem>}</>}
            {container?.kind === 'group' && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => act(() => command({ action: 'dissolve', id: container.id, expectedRevision: container.revision, parents: parents([container.id, container.parentId]) }))}>{t('organization.dissolve')}</DropdownMenuItem></>}
          </DropdownMenuContent></DropdownMenu>
        </div>
      </DropTarget>}</DragRow>
      {(node.children.length > 0 || container) && <div className="grid transition-[grid-template-rows,opacity] duration-[var(--motion-dur-glide)] ease-[var(--motion-ease-glide)]" style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }} inert={!expanded}><div className="min-h-0 overflow-hidden"><div role="group" className="ml-3 border-l border-border/50 pl-1">{node.children.map(render)}{container && expanded && !query.trim() && pageControls(containerQuery(container.id))}{container && <DropTarget id={`end:${node.key}`} line drop={{ parentId: container.id, before: null, label: t('organization.moveEnd', { name: title }) }} />}</div></div></div>}
    </React.Fragment>;
  };
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t('organization.shared')}>
    <div className="flex items-center gap-1 px-2 py-1">
      <button type="button" className="min-w-0 flex-1 truncate text-left typography-meta text-muted-foreground" onClick={() => updatePrefs({ focus: null })}>{t('organization.all')}{prefs.focus && namedSnapshot ? ` / ${organizationContainerPath(namedSnapshot, prefs.focus).map(c => c.name).join(' / ')}` : ''}</button>
      <Button variant="ghost" size="sm" disabled={!snapshot} onClick={() => create(prefs.focus)}>{t('organization.newGroup')}</Button>
      <Button variant="ghost" size="sm" disabled={!snapshot} onClick={() => setProjectCreate({ parentId: prefs.focus })}>{t('organization.project')}</Button>
      <Button variant="ghost" size="sm" disabled={!snapshot} onClick={() => newConversation(prefs.focus)}>{t('organization.new')}</Button>
    </div>
    {!botId && state.bots && state.bots.length > 0 && <label className="flex items-center gap-2 px-3 pb-1 typography-micro text-muted-foreground">{t('organization.identity')}<select aria-label={t('organization.identity')} className="min-w-0 flex-1 rounded border border-border bg-background" value={newBotId} onChange={e => setNewBotId(e.target.value)}><option value="">{t('organization.agent')}</option>{state.bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>}
    {projectCreate && <ProjectCreateDialog open parentContainerId={projectCreate.parentId} onOpenChange={open => { if (!open) { setProjectCreate(null); void refreshConversationOrganization(); } }} />}
    {state.error && <p role="alert" className="px-3 py-2 typography-meta text-destructive">{state.error} <button type="button" className="underline" onClick={() => act(refreshConversationOrganization)}>{t('organization.refresh')}</button></p>}
    {Object.values(state.failed).map(command => <p key={command.key} role="status" className="px-3 typography-meta">{t('organization.unknown')}<button type="button" className="underline" onClick={() => act(() => submitOrganization(command.operation, command))}>{t('organization.checkReceipt')}</button></p>)}
    {undo && <div className="flex items-center gap-2 px-3 py-1 typography-meta"><span>{t('organization.moved')}</span><Button variant="ghost" size="sm" disabled={Object.keys(state.pending).length > 0} onClick={() => act(undoMove)}>{t('organization.undoMove')}</Button></div>}
    {state.loading && <p role="status" className="px-3 typography-meta">{t('organization.loading')}</p>}
    {editor && <form className="mx-2 space-y-2 rounded-md border border-border p-2" onSubmit={event => { event.preventDefault(); if (!editor.name.trim()) return; act(async () => { await command(editor.container ? { action: 'update', id: editor.container.id, expectedRevision: editor.container.revision, name: editor.name.trim(), icon: editor.icon, color: editor.color || null } : { action: 'create', id: editor.id, kind: 'group', parentId: editor.parentId, name: editor.name.trim(), icon: editor.icon, color: editor.color || null, parents: parents([editor.parentId]) }); setEditor(null); }); }}>
      <Input autoFocus aria-label={t('organization.groupName')} value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} onKeyDown={e => { if (composingKey(e)) return; if (e.key === 'Escape') setEditor(null); }} />
      <div className="flex flex-wrap gap-1" aria-label={t('organization.groupIcon')}>{icons.filter(i => Object.hasOwn(iconSpriteData, i)).map(icon => <button type="button" key={icon} aria-label={icon} aria-pressed={editor.icon === icon} className={cn('rounded p-1.5', editor.icon === icon && 'bg-interactive-selection')} onClick={() => setEditor({ ...editor, icon })}><Icon name={icon} className="size-4" /></button>)}</div>
      <div className="flex gap-2" aria-label={t('organization.groupColor')}>{colors.map(color => <button type="button" key={color} aria-label={color || t('organization.theme')} aria-pressed={editor.color === color} className={cn('size-5 rounded-full border border-border', editor.color === color && 'ring-2 ring-primary ring-offset-1')} style={{ backgroundColor: color || 'var(--muted-foreground)' }} onClick={() => setEditor({ ...editor, color })} />)}</div>
      <div className="flex gap-1"><Button type="submit" size="sm" disabled={!editor.name.trim() || Object.keys(state.pending).length > 0}>{t('organization.save')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setEditor(null)}>{t('organization.cancel')}</Button></div>
    </form>}
    {move && namedSnapshot && <form className="mx-2 space-y-2 rounded-md border border-border p-2" onSubmit={e => { e.preventDefault(); act(() => moveNodes(move, { parentId: moving || null, before: null, label: '' })); }}><div className="typography-meta">{t('organization.moveCount', { count: move.length })}<OrganizationDestinationPicker value={moving} onChange={setMoving} snapshot={namedSnapshot} excluded={move.flatMap(node => node.container ? [node.container.id] : [])} disabled={movingBusy} /></div><Button type="submit" size="sm" disabled={movingBusy}>{t('organization.move')}</Button><Button type="button" variant="ghost" size="sm" disabled={movingBusy} onClick={() => { const key = move[0]?.key; setMove(null); [...(list.current?.querySelectorAll<HTMLElement>('[data-sidebar-row]') ?? [])].find(row => row.dataset.sidebarRow === key)?.focus(); }}>{t('organization.cancel')}</Button></form>}
    {rename && <form className="mx-2 flex gap-1" onSubmit={e => { e.preventDefault(); act(async () => { await metadata([rename.node], { title: rename.title }); setRename(null); }); }}><Input autoFocus aria-label={t('organization.conversationName')} value={rename.title} onChange={e => setRename({ ...rename, title: e.target.value })} onKeyDown={e => { if (composingKey(e)) return; if (e.key === 'Escape') setRename(null); }} /><Button type="submit" size="sm" disabled={metadataPending}>{t('organization.save')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setRename(null)}>{t('organization.cancel')}</Button></form>}
    {(selection.size > 0 || selectionMode) && <div className="flex flex-wrap items-center gap-1 px-2 py-1 typography-meta"><span>{t('organization.selectedCount', { count: selection.size })}</span><Button size="sm" variant="ghost" onClick={() => { setMove(selectedNodes); setMoving(''); }}>{t('organization.move')}</Button><Button size="sm" variant="ghost" disabled={metadataPending} onClick={() => act(() => metadata(selectedNodes.filter(n => n.conversation), { archived: !archived }))}>{archived ? t('organization.restore') : t('organization.archive')}</Button><Button size="sm" variant="ghost" disabled={metadataPending} onClick={() => act(() => metadata(selectedNodes.filter(n => n.conversation), { deleted: true }))}>{t('organization.deleteSelected')}</Button><Button size="sm" variant="ghost" onClick={() => { setSelection(new Set()); onExitSelection?.(); }}>{t('organization.endSelection')}</Button></div>}
    {(metadataResults.some(r => r.status !== 'succeeded') || metadataRetry && !metadataPending) && <div role="status" className="px-3 typography-meta">{metadataRetry && !metadataResults.length && <p>{t('organization.unknown')}</p>}{metadataResults.map(r => <p key={organizationObjectKey(r.conversation)}>{r.conversation.id}: {r.status}{r.message && ` · ${r.message}`}</p>)}{metadataRetry && <button type="button" className="underline" disabled={metadataPending} onClick={() => act(() => metadata([], {}, true))}>{t('organization.retryUnconfirmed')}</button>}</div>}
    <DndContext sensors={sensors} onDragStart={e => setDrag(e.active.data.current as OrganizationNode)} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setDrag(null); setDropLabel(''); }}>
      <FlipList containerRef={list} layoutKey={JSON.stringify([roots.map(node => node.key), [...prefs.collapsed], prefs.focus, snapshot?.revision])} instantKey={query} className="relative min-h-0 flex-1 overflow-auto px-2 pb-3"><div role="tree" aria-label={t('organization.directory')}>{shown.map(render)}{pageControls(viewQuery)}<DropTarget id="root:end" drop={{ parentId: prefs.focus, before: null, label: t('organization.currentEnd') }}><div className="min-h-8 px-2 py-2 typography-micro text-muted-foreground">{shown.length || !state.pages[organizationQueryKey(viewQuery)]?.snapshot ? '' : archived ? t('organization.emptyArchive') : t('organization.empty')}{drag && t('organization.dropEnd')}</div></DropTarget></div></FlipList>
      <DragOverlay>{drag ? <div className="rounded-md border border-border bg-popover px-3 py-2 text-sm shadow-md">{name(drag)}{dropLabel && <div className="typography-meta text-muted-foreground">{dropLabel}</div>}</div> : null}</DragOverlay>
    </DndContext>
    <span role="status" aria-live="polite" className="sr-only">{dropLabel}</span>
  </section>;
}
