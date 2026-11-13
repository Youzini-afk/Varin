import { useShallow } from 'zustand/react/shallow';
import React from 'react';
import { DndContext, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, useDraggable, useDroppable, DragOverlay, pointerWithin, closestCenter, type DragEndEvent, type DragOverEvent } from '@dnd-kit/core';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { ConversationOrganizationObject, ConversationOrganizationOperation, ConversationOrganizationQuery, ConversationOrganizationRef } from '@varin/application-client';
import { useConversationOrganization, useConversationOrganizationStore, submitOrganizationMetadata, submitOrganization, refreshConversationOrganization, loadOrganizationPage, readOrganizationActionScope, organizationQueryKey, organizationViewSnapshot } from '@/stores/useConversationOrganizationStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useExternalAgentStore, useExternalAgents } from '@/stores/useExternalAgentStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useOrganizationNavigation } from '@/hooks/useOrganizationNavigation';
import { useConversationOrganizationEntry } from '@/hooks/useConversationOrganizationEntry';
import { startThreadFromNavigation, openThreadFromNavigation, openExternalConversationFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { projectOrganization, projectRecentConversations, organizationObjectKey, organizationContainerPath, nearestOrganizationProject, organizationDropAllowed, type OrganizationNode } from './organizationProjection';
import { useSidebarCatalog } from './sidebarCatalog';
import { sortConversationSessionWorkspaceProjects } from './sessionPresentation';
import { OrganizationRow } from './OrganizationRow';
import { OrganizationContainerIcon } from './OrganizationContainerIcon';
import { OrganizationGroupDialog, type OrganizationGroupEditor } from './OrganizationGroupDialog';
import { OrganizationDestinationPicker } from './OrganizationDestinationPicker';
import { OrganizationOperationFeedback } from './OrganizationOperationFeedback';
import { ConversationOrigin } from './ConversationOrigin';
import { FlipList } from './FlipList';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { HarnessIcon } from '@/components/thread/HarnessIcon';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { noteSwitchDirection } from '@/lib/motion/switchDirection';
import { formatSessionCompactDateLabel } from '@/lib/sessionDateLabels';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { isLeadThread } from '@/lib/agent-runtime/threadRole';
import { useUIStore } from '@/stores/useUIStore';
import { useBotWorkspaceNavigation } from '@/workbenches/bot/botWorkspaceViews';
import { workKey, isWaitingStatus, runStatus } from '@/workbenches/bot/botPresentation';
import { ProjectCreateDialog } from '@/components/sections/projects/ProjectCreateDialog';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { openProjectFiles } from '@/lib/openProjectFiles';
import { openBotEntryFor, useBotNavigation } from '@/lib/bots';
import { useHoverPill, useSelectionGlide } from './sidebarHighlights';
import './organization.css';

type Drop = { parentId: string | null; before: ConversationOrganizationObject | null; label: string; reorder?: boolean };
const composingKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) return false;
  if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
  return true;
};
function DropTarget({ id, drop, children, line = false, disabled = false }: { id: string; drop: Drop; children?: React.ReactNode; line?: boolean; disabled?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id, data: drop, disabled });
  return <div ref={setNodeRef} className={cn(line ? 'relative z-10 -my-0.5 h-1 rounded transition-colors' : 'rounded-md', isOver && (line ? 'bg-primary' : 'bg-interactive-selection ring-1 ring-primary/50'))}>{children}</div>;
}
function DragRow({ node, pending, expanded, children }: { node: OrganizationNode; pending: boolean; expanded: boolean; children: (handle: React.ReactNode) => React.ReactNode }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: node.key, data: node, disabled: pending });
  return <div ref={setNodeRef} data-flip-key={node.key} data-flip-arrive="" data-collapsed={!expanded && (node.container || node.children.length) ? '' : undefined} className={cn('transition-opacity', (isDragging || pending) && 'opacity-45')} aria-busy={pending || undefined}>
    {children(<button type="button" {...attributes} {...listeners} className="organization-icon-button organization-drag" aria-label={t('organization.drag')}><Icon name="draggable" className="size-3" /></button>)}
  </div>;
}
export interface OrganizationNavigationHandle { newConversation(botId?: string | null): void; newGroup(): void; addProject(): void }
export interface ConversationOrganizationTreeProps {
  query?: string; archived?: boolean; botId?: string; defaultBotId?: string; flat?: boolean; viewKey?: string; showRoot?: boolean; stickyHeaders?: boolean;
  sortOrder?: 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent'; expansion?: { revision: number; expanded: boolean };
  selectionMode?: boolean; onExitSelection?(): void; onNavigate?(): void; onSearchReset?(): void; onFocusChange?(name: string | null): void;
}
export const ConversationOrganizationTree = React.forwardRef<OrganizationNavigationHandle, ConversationOrganizationTreeProps>(function ConversationOrganizationTree({ query = '', archived = false, botId, defaultBotId, flat = false, viewKey = 'workbench', showRoot = true, stickyHeaders = false, sortOrder = 'manual', expansion, selectionMode = false, onExitSelection, onNavigate, onSearchReset, onFocusChange }, ref) {
  const { t } = useI18n();
  const excludeBotConversations = viewKey !== 'bot';
  useExternalAgents();
  const state = useConversationOrganization(true, useShallow(state => ({ host: state.host, snapshot: state.snapshot, pages: state.pages, loading: state.loading, error: state.error, pending: state.pending, failed: state.failed, metadata: state.metadata, bots: state.bots })));
  const botWorkspace = useBotWorkspaceNavigation();
  const apis = useRuntimeAPIs();
  const projects = useProjectsStore(s => s.projects);
  const threads = useThreadStore(s => s.threads);
  const botEntry = useBotNavigation(s => s.entry);
  const selected = useThreadStore(s => s.selectedIdentity);
  const externalChildren = useExternalAgentStore(s => s.children);
  const external = useExternalAgentStore(s => s.conversations);
  const externalSelected = useExternalAgentStore(s => s.selectedId);
  const sidebar = useSidebarCatalog(viewKey === 'bot');
  const snapshot = state.host === getRuntimeEndpointGeneration() ? state.snapshot : null;
  const [preference, setPreference] = useOrganizationNavigation(viewKey);
  const knownKeys = new Set([...(snapshot?.containers ?? []).map(c => organizationObjectKey({ kind: 'container', id: c.id })), ...(snapshot?.conversations ?? []).map(e => organizationObjectKey(e.conversation))]);
  const recent = preference.view === 'recent' && !preference.focus;
  const selectionTargets = React.useRef(new Map<string, OrganizationNode>());
  const [selection, setSelection] = React.useState<Set<string>>(new Set());
  const [editor, setEditor] = React.useState<OrganizationGroupEditor | null>(null);
  const [projectCreate, setProjectCreate] = React.useState<{ parentId: string | null } | null>(null);
  const [undo, setUndo] = React.useState<Extract<ConversationOrganizationOperation, { action: 'restore' }>['items'] | null>(null);
  const [movingBusy, setMovingBusy] = React.useState(false);
  const [move, setMove] = React.useState<OrganizationNode[] | null>(null);
  const [moving, setMoving] = React.useState('');
  const [drag, setDrag] = React.useState<OrganizationNode | null>(null);
  const [dropLabel, setDropLabel] = React.useState('');
  const [rename, setRename] = React.useState<{ node: OrganizationNode; title: string } | null>(null);
  const [confirmation, setConfirmation] = React.useState<{ title: string; description: string; action: string; run(): Promise<unknown> } | null>(null);
  const metadataIntents = state.host === getRuntimeEndpointGeneration() ? Object.values(state.metadata) : [];
  const metadataBusy = (nodes: OrganizationNode[]) => metadataIntents.some(intent => intent.pending && intent.input.items.some(item => nodes.some(node => node.key === organizationObjectKey(item.conversation))));
  const list = React.useRef<HTMLDivElement>(null);
  const activePanel = botWorkspace?.views.find(view => view.key === botWorkspace.activeKey);
  const selectedObject = viewKey === 'bot' ? activePanel?.kind === 'work' ? { kind: 'native' as const, id: activePanel.identity.threadId } : activePanel?.kind === 'external' ? { kind: 'external' as const, id: activePanel.id } : botEntry ? { kind: 'native' as const, id: botEntry.threadId } : null : selected ? { kind: 'native' as const, id: selected.threadId } : externalSelected ? { kind: 'external' as const, id: externalSelected } : null;
  const selectedEntry = useConversationOrganizationEntry(selectedObject ?? { kind: 'native', id: '' }, !!selectedObject, true);
  const revealKey = JSON.stringify([state.host, selectedObject, selectedEntry.entry?.path]);
  React.useEffect(() => {
    if (!selectedObject || !selectedEntry.entry) return;
    setPreference({ expanded: Object.fromEntries(selectedEntry.entry.path.map(id => [organizationObjectKey({ kind: 'container', id }), true])) });
  // The selected path changes independently of directory refreshes and manual folding.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);
  React.useEffect(() => { setSelection(new Set()); setUndo(null); setMovingBusy(false); setEditor(null); setMove(null); setRename(null); setProjectCreate(null); setMoving(''); setConfirmation(null); selectionTargets.current.clear(); }, [state.host, apis.conversationOrganization]);
  React.useEffect(() => { if (!selectionMode) setSelection(new Set()); }, [selectionMode]);
  const previousBot = React.useRef(botId);
  React.useEffect(() => {
    if (previousBot.current !== botId) { previousBot.current = botId; setPreference({ focus: null }); setSelection(new Set()); }
  }, [botId, setPreference]);
  const namedSnapshot = React.useMemo(() => snapshot ? { ...snapshot, containers: snapshot.containers.map(c => c.kind === 'project' ? { ...c, name: projects.find(p => p.id === c.projectId)?.label || projects.find(p => p.id === c.projectId)?.path.split(/[\\/]/).filter(Boolean).at(-1) || t('organization.projectUnavailable') } : c) } : null, [snapshot, projects, t]);
  React.useEffect(() => { onFocusChange?.(namedSnapshot?.containers.find(container => container.id === preference.focus)?.name ?? null); }, [preference.focus, namedSnapshot, onFocusChange]);
  const scopeQuery = React.useMemo<ConversationOrganizationQuery>(() => ({ pageNodes: true, archived: archived ? 'only' : 'exclude', ...(excludeBotConversations ? { excludeBotConversations: true } : {}), ...(botId ? { botId } : {}), ...(recent ? { kind: 'conversations', sort: 'recent', recursive: true, conversationTree: {} } : {}), ...(query.trim() ? { query: query.trim(), recursive: true } : !recent ? { rootOnly: true } : {}) }), [archived, botId, query, recent, excludeBotConversations]);
  const conversationQuery = React.useCallback((parent: ConversationOrganizationRef): ConversationOrganizationQuery => ({ ...scopeQuery, conversationTree: { parent } }), [scopeQuery]);
  const containerQuery = React.useCallback((containerId: string): ConversationOrganizationQuery => ({ pageNodes: true, containerId, archived: archived ? 'only' : 'exclude', ...(excludeBotConversations ? { excludeBotConversations: true } : {}), ...(botId ? { botId } : {}) }), [archived, botId, excludeBotConversations]);
  const viewQuery = React.useMemo(() => preference.focus && !query.trim() ? containerQuery(preference.focus) : scopeQuery, [preference.focus, query, containerQuery, scopeQuery]);
  React.useEffect(() => { void loadOrganizationPage(viewQuery); }, [viewQuery, state.host]);
  const visibleSnapshot = React.useMemo(() => organizationViewSnapshot(state.pages, viewQuery, object => !!query.trim() || preference.expanded[organizationObjectKey(object)] === true), [state.pages, viewQuery, preference.expanded, query]);
  const namedVisibleSnapshot = React.useMemo(() => visibleSnapshot ? { ...visibleSnapshot, containers: visibleSnapshot.containers.map(c => namedSnapshot?.containers.find(named => named.id === c.id) ?? c) } : null, [visibleSnapshot, namedSnapshot]);
  const roots = React.useMemo<OrganizationNode[]>(() => {
    if (!namedVisibleSnapshot) return [];
    if (recent) return projectRecentConversations(namedVisibleSnapshot, { archived, botId, excludeBotConversations });
    const projected = projectOrganization(namedVisibleSnapshot, { query, archived, botId, flat, excludeBotConversations });
    const projectOrder = new Map(sortConversationSessionWorkspaceProjects(projects, sortOrder).map((project, index) => [project.id, index]));
    const sort = (items: OrganizationNode[]): OrganizationNode[] => {
      const containers = items.filter(node => node.container);
      // The existing project sort concerns registered projects; groups retain their manual slots.
      const sortedProjects = containers.filter(node => node.container?.kind === 'project').sort((a, b) => (projectOrder.get(a.container!.projectId!) ?? 0) - (projectOrder.get(b.container!.projectId!) ?? 0));
      let pi = 0;
      const orderedContainers = sortOrder === 'manual' ? containers : containers.map(node => node.container?.kind === 'project' ? sortedProjects[pi++] : node);
      const conversations = items.filter(node => node.conversation).sort((a, b) => Number(!!b.conversation?.pinned) - Number(!!a.conversation?.pinned) || a.order - b.order);
      return [...orderedContainers, ...conversations].map(node => ({ ...node, children: sort(node.children) }));
    };
    return sort(projected.filter(node => showRoot || query.trim() || node.container));
  }, [namedVisibleSnapshot, recent, query, archived, botId, flat, projects, sortOrder, showRoot, excludeBotConversations]);
  const expandedRevision = React.useRef(0);
  React.useEffect(() => {
    if (!snapshot || !expansion || expansion.revision === expandedRevision.current) return;
    expandedRevision.current = expansion.revision;
    setPreference({ expanded: Object.fromEntries([...knownKeys].map(key => [key, expansion.expanded])) });
  // Only an explicit expand/collapse command changes the loaded nodes' choices.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expansion?.revision, snapshot]);
  const nodes = new Map<string, OrganizationNode>();
  const walk = (items: OrganizationNode[]) => { for (const node of items) { nodes.set(node.key, node); walk(node.children); } }; walk(roots);
  const focused = preference.focus ? nodes.get(organizationObjectKey({ kind: 'container', id: preference.focus })) : null;
  const shown = focused && !query.trim() ? focused.children : roots;
  const listLayoutKey = JSON.stringify([[...nodes.keys()], preference.expanded, preference.focus, recent, snapshot?.revision, query]);
  useSelectionGlide(list, selectedObject ? organizationObjectKey(selectedObject) : null, listLayoutKey);
  useHoverPill(list);
  const openedContainers: string[] = [];
  const openedConversations: ConversationOrganizationRef[] = [];
  const collectOpened = (items: OrganizationNode[]) => { for (const node of items) if (query.trim() || preference.expanded[node.key]) { if (node.container) openedContainers.push(node.container.id); if (recent && node.conversation?.hasChildren) openedConversations.push(node.conversation.conversation); collectOpened(node.children); } };
  if (recent) collectOpened(shown);
  else if (!query.trim()) { if (preference.focus) openedContainers.push(preference.focus); collectOpened(shown); }
  const openedKey = JSON.stringify({ containers: openedContainers, conversations: openedConversations });
  React.useEffect(() => {
    const opened = JSON.parse(openedKey) as { containers: string[]; conversations: ConversationOrganizationRef[] };
    for (const id of opened.containers) void loadOrganizationPage(containerQuery(id));
    for (const parent of opened.conversations) void loadOrganizationPage(conversationQuery(parent));
  }, [openedKey, containerQuery, conversationQuery, state.host]);
  const pageControls = (pageQuery: ConversationOrganizationQuery): React.ReactNode => {
    const page = state.pages[organizationQueryKey(pageQuery)];
    return <>{page?.loading && <p role="status" className="px-2 py-1 typography-micro text-muted-foreground">{t('common.loading')}</p>}{page?.error && <p role="alert" className="px-2 typography-micro text-destructive">{page.error}<Button variant="ghost" size="sm" onClick={() => act(refreshConversationOrganization)}>{t('common.retry')}</Button></p>}{page?.snapshot?.nextCursor && <Button variant="ghost" size="sm" onClick={() => act(() => loadOrganizationPage(pageQuery, true))}>{t('organization.loadMore')}</Button>}</>;
  };

  const pendingObjects = new Set(Object.values(state.pending).flatMap(command => command.operation.action === 'move' || command.operation.action === 'restore' ? command.operation.items.map(item => organizationObjectKey(item.object)) : command.operation.action === 'create' ? [] : [organizationObjectKey({ kind: 'container', id: command.operation.id })]));
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }), useSensor(KeyboardSensor));
  const act = (work: () => Promise<unknown>) => { void work().catch(error => toast.error(error instanceof Error ? error.message : String(error))); };
  const parents = (ids: (string | null)[], source = snapshot) => {
    if (!source) throw new Error(t('organization.scopeChanged'));
    return [...new Set(ids)].map(containerId => {
      const childrenRevision = containerId ? source.containers.find(container => container.id === containerId)?.childrenRevision : source.rootRevision;
      if (childrenRevision === undefined) throw new Error(t('organization.scopeChanged'));
      return { containerId, childrenRevision };
    });
  };
  const command = (operation: ConversationOrganizationOperation) => submitOrganization(operation);
  const moveNodes = async (items: OrganizationNode[], drop: Drop) => {
    if (!snapshot || !items.length || movingBusy) return;
    if (!organizationDropAllowed(snapshot, items, drop)) return;
    if (!drop.reorder && !drop.before && items.every(item => item.parentId === drop.parentId)) { setMove(null); return; }
    const host = state.host; setMovingBusy(true);
    let attempted: ConversationOrganizationOperation | undefined;
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
      attempted = { action: 'move', items: items.map(n => ({ object: n.object, expectedRevision: n.container?.revision ?? n.conversation!.position.revision, expectedParentId: n.parentId })), parentId: drop.parentId, before: drop.before, parents: parents([...items.map(n => n.parentId), drop.parentId]) };
      const receipt = await command(attempted);
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
    } catch (error) {
      if (host === getRuntimeEndpointGeneration() && attempted && Object.values(useConversationOrganizationStore.getState().failed).some(command => JSON.stringify(command.operation) === JSON.stringify(attempted))) setMove(null);
      throw error;
    } finally { if (host === getRuntimeEndpointGeneration()) setMovingBusy(false); }
  };
  const undoMove = async () => {
    if (!undo) return;
    const host = state.host;
    if (host !== getRuntimeEndpointGeneration()) throw new Error(t('organization.scopeChanged'));
    const parentIds = [...new Set(undo.flatMap(item => [item.expectedParentId, item.parentId]))];
    // A move from Recent may leave its old parent outside every loaded page. Read just
    // enough ancestor metadata for current parent CAS; the original anchors stay fixed.
    const scopes = await Promise.all(parentIds.map(containerId => apis.conversationOrganization!.read({ pageNodes: true, ...(containerId ? { containerId } : { rootOnly: true }), archived: 'include', limit: 1 })));
    if (host !== getRuntimeEndpointGeneration()) throw new Error(t('organization.scopeChanged'));
    // Expected object revisions come from our receipt, never a newer client's movement.
    const receipt = await command({ action: 'restore', items: undo, parents: parentIds.map((id, index) => parents([id], scopes[index])[0]) });
    if (receipt && host === getRuntimeEndpointGeneration()) setUndo(current => current === undo ? null : current);
  };
  const allNodes = new Map<string, OrganizationNode>([...(snapshot?.containers ?? []).map(container => ({ key: organizationObjectKey({ kind: 'container', id: container.id }), object: { kind: 'container' as const, id: container.id }, parentId: container.parentId, order: container.order, container, children: [] })), ...(snapshot?.conversations ?? []).map(conversation => ({ key: organizationObjectKey(conversation.conversation), object: conversation.conversation, parentId: conversation.position.containerId, order: conversation.position.order, conversation, children: [] }))].map(node => [node.key, node]));
  const selectedNodes = [...selection].flatMap(key => allNodes.get(key) ?? selectionTargets.current.get(key) ?? []);
  const draggedNodes = drag ? selection.has(drag.key) ? selectedNodes : [drag] : [];
  const canDrop = (parentId: string | null, before: ConversationOrganizationObject | null = null) => !!snapshot && organizationDropAllowed(snapshot, draggedNodes, { parentId, before });
  const onDragEnd = (event: DragEndEvent) => {
    const node = event.active.data.current as OrganizationNode | undefined;
    const drop = event.over?.data.current as Drop | undefined;
    setDrag(null); setDropLabel('');
    if (!event.delta.x && !event.delta.y) return;
    if (node && drop) act(() => moveNodes(selection.has(node.key) ? selectedNodes : [node], drop));
  };
  const onDragOver = (event: DragOverEvent) => setDropLabel((event.over?.data.current as Drop | undefined)?.label ?? '');
  const create = (parentId: string | null) => setEditor({ id: crypto.randomUUID(), parentId, name: '', icon: 'stack', color: '' });
  const newConversation = (containerId: string | null, identity: string | null | undefined = defaultBotId ?? botId) => act(async () => {
    const projectId = nearestOrganizationProject(snapshot!, containerId);
    const project = projects.find(p => p.id === projectId);
    await startThreadFromNavigation({ directory: project?.path, projectId: projectId ?? undefined, organization: { containerId }, ...(identity ? { botId: identity } : {}) });
    onNavigate?.();
  });
  const metadata = async (items: OrganizationNode[], patch: { archived?: boolean; deleted?: boolean; pinned?: boolean; title?: string }) => {
    await submitOrganizationMetadata(items.flatMap(n => n.conversation ? [{ conversation: n.conversation.conversation, expectedRevision: n.conversation.revision, patch }] : []));
  };
  const archiveContainer = async (containerId: string, recursive: boolean) => {
    const scope = await readOrganizationActionScope({ containerId, recursive, archived: archived ? 'only' : 'exclude', ...(excludeBotConversations ? { excludeBotConversations: true } : {}) });
    await metadata(scope.conversations.map(conversation => ({ key: organizationObjectKey(conversation.conversation), object: conversation.conversation, parentId: conversation.position.containerId, order: conversation.position.order, conversation, children: [] })), { archived: !archived });
  };
  const name = (node: OrganizationNode) => node.container?.name ?? node.conversation?.title ?? t('organization.untitled');
  const threadById = new Map(threads.map(thread => [thread.thread_id, thread]));
  const externalById = new Map(external.map(conversation => [conversation.id, conversation]));
  const delegationById = new Map(externalChildren.map(child => [child.conversationId, child]));
  const summaryByKey = new Map(sidebar.summaries.map(summary => [organizationObjectKey({ kind: summary.harness ? 'external' : 'native', id: summary.id }), summary]));
  const confirmDelete = useUIStore(store => store.showDeletionDialog);
  const [confirming, setConfirming] = React.useState<typeof confirmation>(null);
  const previousRename = React.useRef(rename); if (rename) previousRename.current = rename;
  const renameContents = rename ?? previousRename.current;
  const previousMove = React.useRef(move); if (move) previousMove.current = move;
  const moveContents = move ?? previousMove.current;
  const previousConfirmation = React.useRef(confirmation); if (confirmation) previousConfirmation.current = confirmation;
  const confirmationContents = confirmation ?? previousConfirmation.current;
  const location = (id: string | null) => namedSnapshot ? organizationContainerPath(namedSnapshot, id).map(container => container.name).join(' / ') || t('organization.all') : t('organization.all');
  const selectNode = (node: OrganizationNode) => setSelection(previous => { selectionTargets.current.set(node.key, node); const next = new Set(previous); if (next.has(node.key)) next.delete(node.key); else next.add(node.key); return next; });
  const chooseMove = (items: OrganizationNode[]) => { setMove(items); setMoving(items[0]?.parentId ?? ''); };
  const requestDelete = (items: OrganizationNode[]) => {
    const work = () => metadata(items, { deleted: true });
    if (confirmDelete) setConfirmation({ title: t('organization.deleteConfirm', { name: items.length === 1 ? name(items[0]) : t('organization.selectedCount', { count: items.length }) }), description: t('organization.deleteDescription'), action: t('organization.deleteSelected'), run: work });
    else act(work);
  };
  React.useImperativeHandle(ref, () => ({ newConversation: identity => newConversation(preference.focus, identity), newGroup: () => create(preference.focus), addProject: () => setProjectCreate({ parentId: preference.focus }) }));
  React.useEffect(() => {
    if (!undo) return;
    const toastId = toast.success(t('organization.moved'), { action: { label: t('organization.undoMove'), onClick: () => act(undoMove) } });
    return () => { toast.dismiss(toastId); };
  // A receipt creates one notification; directory refreshes do not replace its action.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo]);
  const render = (node: OrganizationNode): React.ReactNode => {
    const entry = node.conversation, container = node.container;
    const project = container?.kind === 'project' ? projects.find(project => project.id === container.projectId) : undefined;
    const title = name(node), expanded = !!query.trim() || preference.expanded[node.key] === true;
    const thread = entry?.conversation.kind === 'native' ? threadById.get(node.object.id) : undefined;
    const ext = entry?.conversation.kind === 'external' ? externalById.get(node.object.id) : undefined;
    const active = !!entry && selectedObject?.kind === entry.conversation.kind && selectedObject.id === entry.conversation.id;
    const pathLabel = entry && namedSnapshot ? organizationContainerPath(namedSnapshot, entry.position.containerId).map(container => container.name).join(' / ') || t('organization.uncategorized') : '';
    const inheritedFrom = entry?.position.inheritedFrom;
    const originatingTitle = inheritedFrom ? snapshot?.conversations.find(candidate => organizationObjectKey(candidate.conversation) === organizationObjectKey(inheritedFrom))?.title ?? (inheritedFrom.kind === 'native' ? threadById.get(inheritedFrom.id)?.title : externalById.get(inheritedFrom.id)?.title) : null;
    const toggle = () => { if (query.trim()) return; setPreference({ expanded: { [node.key]: !expanded } }); };
    const open = () => {
      if (!entry) { if (query.trim() && container && onSearchReset) { setPreference({ focus: container.id }); onSearchReset(); } else toggle(); return; }
      act(async () => {
        const rows = [...(list.current?.querySelectorAll('[data-sidebar-row]') ?? [])];
        const from = rows.findIndex(row => row.getAttribute('data-current') === 'true'), to = rows.findIndex(row => row.getAttribute('data-sidebar-row') === node.key);
        noteSwitchDirection(from >= 0 && to >= 0 ? to - from : 0);
        if (viewKey === 'bot' && botWorkspace && !entry.origin.directBotId) {
          if (entry.conversation.kind === 'external') botWorkspace.open({ kind: 'external', key: `external:${entry.conversation.id}`, id: entry.conversation.id, title });
          else { const { identity } = await useThreadStore.getState().resolveThread({ threadId: entry.conversation.id }); botWorkspace.open({ kind: 'work', key: workKey(identity), identity, title }); }
          return;
        }
        await (entry.conversation.kind === 'native' ? openThreadFromNavigation({ threadId: node.object.id }) : openExternalConversationFromNavigation(node.object.id));
        onNavigate?.();
      });
    };
    const menuItems = (context: boolean) => {
      const Item = context ? ContextMenuItem : DropdownMenuItem;
      const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
      const Sub = context ? ContextMenuSub : DropdownMenuSub;
      const SubTrigger = context ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
      const SubContent = context ? ContextMenuSubContent : DropdownMenuSubContent;
      return <>
        {container && <>
          <Item onClick={() => newConversation(container.id, null)}><Icon name="chat-new" className="size-3.5" />{t('organization.newConversation')}</Item>
          {viewKey === 'bot' && !!state.bots?.length && <Sub><SubTrigger><Icon name="robot" className="size-3.5" />{t('organization.newWithBot')}</SubTrigger><SubContent>{state.bots.map(bot => <Item key={bot.id} disabled={bot.archived || !!bot.deletion || bot.activity?.state === 'asleep'} onClick={() => newConversation(container.id, bot.id)}>{t('organization.newWithName', { name: bot.name })}</Item>)}</SubContent></Sub>}
          <Item onClick={() => create(container.id)}><Icon name="folder-add" className="size-3.5" />{t('organization.newGroupMenu')}</Item>
          <Item onClick={() => setProjectCreate({ parentId: container.id })}><Icon name="code-box" className="size-3.5" />{t('organization.addProject')}</Item>
          <Separator />
          <Item onClick={() => setPreference({ focus: container.id, view: 'classified' })}><Icon name="fullscreen" className="size-3.5" />{t('organization.enter')}</Item>
          {container.kind === 'group' ? <Item onClick={() => setEditor({ id: container.id, container, parentId: container.parentId, name: container.name ?? '', icon: container.icon ?? 'stack', color: container.color ?? '' })}><Icon name="pencil-ai" className="size-3.5" />{t('organization.editGroup')}</Item> : <>
            {project && <Item onClick={() => act(async () => { if (botWorkspace && viewKey === 'bot') botWorkspace.files(project.source?.resourceOwner ?? { kind: 'local' }, project.label || project.path, undefined, project.path); else { await openProjectFiles(project); onNavigate?.(); } })}><Icon name="folder-open" className="size-3.5" />{t('organization.projectFiles')}</Item>}
            <Item onClick={() => { const ui = useUIStore.getState(); ui.setSettingsProjectsSelectedId(container.projectId); ui.setSettingsPage('projects'); ui.setSettingsDialogOpen(true); onNavigate?.(); }}><Icon name="settings-3" className="size-3.5" />{t('organization.projectSettings')}</Item>
          </>}
        </>}
        {entry && <>
          <Item onClick={() => setRename({ node, title })}><Icon name="pencil-ai" className="size-3.5" />{t('organization.rename')}</Item>
          <Item onClick={() => act(() => metadata([node], { pinned: !entry.pinned }))}><Icon name={entry.pinned ? 'unpin' : 'pushpin'} className="size-3.5" />{t(entry.pinned ? 'organization.unpin' : 'organization.pin')}</Item>
        </>}
        <Item onClick={() => chooseMove(selection.has(node.key) ? selectedNodes : [node])}><Icon name="folder-received" className="size-3.5" />{t('organization.moveTo')}</Item>
        <Item onClick={() => { selectionTargets.current.set(node.key, node); setSelection(new Set([...selection, node.key])); }}><Icon name="checkbox-multiple" className="size-3.5" />{t('organization.select')}</Item>
        {container && <Sub><SubTrigger><Icon name="inbox-archive" className="size-3.5" />{t(archived ? 'organization.restoreConversation' : 'organization.archiveConversation')}</SubTrigger><SubContent>
          <Item onClick={() => act(() => archiveContainer(container.id, false))}>{t(archived ? 'organization.restoreDirect' : 'organization.archiveDirect')}</Item>
          <Item onClick={() => act(() => archiveContainer(container.id, true))}>{t(archived ? 'organization.restoreDescendants' : 'organization.archiveDescendants')}</Item>
        </SubContent></Sub>}
        {entry && <Item onClick={() => act(() => metadata([node], { archived: !entry.archived }))}><Icon name="inbox-archive" className="size-3.5" />{t(entry.archived ? 'organization.restoreConversation' : 'organization.archiveConversation')}</Item>}
        {entry?.origin.conversation && <Item onClick={() => act(() => entry.origin.conversation!.kind === 'native' ? openThreadFromNavigation({ threadId: entry.origin.conversation!.id }) : openExternalConversationFromNavigation(entry.origin.conversation!.id))}><Icon name="arrow-go-back" className="size-3.5" />{t('organization.origin')}</Item>}
        {entry?.origin.directBotId && <Item onClick={() => act(() => openBotEntryFor(entry.origin.directBotId!))}>{t('organization.botProfile')}</Item>}
        {thread && <>
          {thread.branches.length > 1 && <Sub><SubTrigger><Icon name="git-branch" className="size-3.5" />{t('thread.sidebar.mainBranch')}</SubTrigger><SubContent>{thread.branches.map((branch, index) => <Item key={branch.branch_id} onClick={() => act(() => openThreadFromNavigation({ threadId: thread.thread_id, branchId: branch.branch_id }))}>{branch.branch_id === thread.main_branch_id ? t('thread.sidebar.mainBranch') : t('thread.sidebar.branch', { number: index + 1 })}</Item>)}</SubContent></Sub>}
          {!thread.parent_thread_id && thread.title_mode === 'manual' && <Item onClick={() => act(() => useThreadStore.getState().updateThread(thread.thread_id, { titleMode: 'automatic' }))}>{t('sessions.sidebar.session.menu.resumeTitles')}</Item>}
          {canUseElectronDesktopIPC() && <Item onClick={() => act(() => invokeDesktop('desktop_open_thread_mini_chat_window', { threadId: thread.thread_id, branchId: selected?.threadId === thread.thread_id ? selected.branchId : thread.main_branch_id }))}>{t('sessions.sidebar.session.menu.openMiniChatWindow')}</Item>}
        </>}
        <Separator />
        {entry && <Item data-variant="destructive" onClick={() => requestDelete([node])}><Icon name="delete-bin" className="size-3.5" />{t('organization.deleteConversation')}</Item>}
        {container?.kind === 'group' && <Item onClick={() => setConfirmation({ title: t('organization.dissolve'), description: t('organization.dissolveDescription'), action: t('organization.dissolveAction'), run: () => command({ action: 'dissolve', id: container.id, expectedRevision: container.revision, parents: parents([container.id, container.parentId]) }) })}>{t('organization.dissolve')}</Item>}
        {container?.kind === 'project' && <Item onClick={() => setConfirmation({ title: t('organization.removeProject'), description: t('organization.removeDescription'), action: t('organization.removeAction'), run: async () => { await useProjectsStore.getState().removeProject(container.projectId!); await refreshConversationOrganization(); } })}>{t('organization.removeProject')}</Item>}
      </>;
    };
    const rowIcon = container ? <OrganizationContainerIcon container={container} project={project} /> : entry?.origin.directBotId ? <ConversationOrigin origin={entry.origin} main /> : ext ? ext.parent ? <AgentAvatar identity={node.object.id} avatar={delegationById.get(node.object.id)?.avatar} size={20} /> : <HarnessIcon harness={ext.harness} /> : <AgentAvatar identity={node.object.id} avatar={thread?.avatar} size={20} {...(thread && isLeadThread(thread, threadById) ? { role: 'lead' as const } : {})} />;
    const busy = !!(thread?.branches.some(branch => branch.active_run_id) || ext?.activeTurn);
    const waiting = !!thread?.branches.some(branch => isWaitingStatus(runStatus(branch.latest_run)));
    const attention = thread?.unread && !active && !busy ? { kind: thread.branches.some(branch => branch.latest_run?.state === 'failed') ? 'error' as const : 'complete' as const, updatedAt: thread.updated_at_ms } : undefined;
    const updated = entry?.updatedAtMs ?? thread?.updated_at_ms ?? ext?.updatedAt;
    // Reordering respects the visible container/conversation and pin segments. Moving into a
    // different location remains available on its row, independently of display sorting.
    const reorderable = !query.trim() && canDrop(node.parentId, node.object) && (!container || sortOrder === 'manual') && (!entry?.position.inheritedFrom || entry.position.explicit) && draggedNodes.every(candidate => !!candidate.container === !!container && (!entry || !!candidate.conversation?.pinned === !!entry.pinned));
    return <React.Fragment key={node.key}>
      {!recent && <DropTarget id={`before:${node.key}`} line disabled={!reorderable} drop={{ parentId: node.parentId, before: node.object, label: t('organization.moveBefore', { name: title }) }} />}
      <DragRow node={node} pending={pendingObjects.has(node.key)} expanded={expanded}>{handle => <><DropTarget id={`inside:${node.key}`} disabled={!!query.trim() || !container || !canDrop(container.id)} drop={{ parentId: container?.id ?? node.parentId, before: null, label: t('organization.moveInside', { name: container ? title : t('organization.category') }) }}>
        <ContextMenu><ContextMenuTrigger asChild><div className={cn(stickyHeaders && container && 'sticky top-0 z-10 bg-sidebar/95 backdrop-blur-sm')}>
          <OrganizationRow id={node.key} title={title} icon={rowIcon} origin={entry && <ConversationOrigin origin={entry.origin} />} active={active} container={!!container} recent={recent} expanded={expanded} expandable={!!(node.children.length || container || entry?.hasChildren)} selected={selection.has(node.key)} selecting={selection.size > 0 || selectionMode}
            busy={busy} waiting={waiting} attention={attention} pinned={entry?.pinned} path={entry && (recent || flat || query.trim()) ? [pathLabel, !recent && originatingTitle].filter(Boolean).join(' · ') : undefined} time={updated === undefined ? undefined : formatSessionCompactDateLabel(updated)} summary={summaryByKey.get(node.key)} onOpen={open} onToggle={toggle} onSelect={() => selectNode(node)}
            onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter') open(); if (event.key === 'ArrowRight' && !expanded || event.key === 'ArrowLeft' && expanded) { event.preventDefault(); toggle(); } if (event.key === ' ' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); selectNode(node); } if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const rows = [...(list.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].filter(row => !row.closest('[inert]')); rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus(); } }}
            actions={<>{!recent && handle}{container && <button type="button" className="organization-icon-button organization-row-new" aria-label={t('organization.newIn', { name: title })} onClick={() => newConversation(container.id)}><Icon name="add" className="size-3.5" /></button>}{project && <ProjectActionsButton projectRef={{ id: project.id, path: project.path, resourceOwner: project.source?.resourceOwner, source: project.source, versionedWorkspace: project.versionedWorkspace }} directory={project.path} allowMobile menuTrigger={<button type="button" className="organization-icon-button" aria-label={t('sessions.sidebar.project.actions.projectMenu')}><Icon name="play" className="size-3.5" /></button>} />}<DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label={t('organization.actions', { name: title })} className="organization-icon-button organization-row-more"><Icon name="more" className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-48">{menuItems(false)}</DropdownMenuContent></DropdownMenu></>} />
        </div></ContextMenuTrigger><ContextMenuContent className="min-w-48">{menuItems(true)}</ContextMenuContent></ContextMenu>
      </DropTarget>
      {(node.children.length > 0 || container || entry?.hasChildren) && <div className="organization-fold" style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }} inert={!expanded}><div className="min-h-0 overflow-hidden"><div role="group" className={container ? 'organization-children' : 'organization-task-children'}>{node.children.map(render)}{recent && entry?.hasChildren && expanded && pageControls(conversationQuery(entry.conversation))}{container && expanded && !query.trim() && pageControls(containerQuery(container.id))}{container && <DropTarget id={`end:${node.key}`} line disabled={!canDrop(container.id)} drop={{ reorder: true, parentId: container.id, before: null, label: t('organization.moveEnd', { name: title }) }} />}</div></div></div>}
      </>}</DragRow>
    </React.Fragment>;
  };
  const saveGroup = () => {
    if (!editor) return;
    const current = editor, host = state.host;
    act(async () => {
      try {
        await command(current.container ? { action: 'update', id: current.container.id, expectedRevision: current.container.revision, name: current.name.trim(), icon: current.icon, color: current.color || null } : { action: 'create', id: current.id, kind: 'group', parentId: current.parentId, name: current.name.trim(), icon: current.icon, color: current.color || null, parents: parents([current.parentId]) });
        if (host === getRuntimeEndpointGeneration()) setEditor(value => value?.id === current.id ? null : value);
      } catch (error) {
        // Ambiguous admission is checked from the original command in the navigator.
        // Keep ordinary validation/conflict errors editable in the dialog.
        if (host === getRuntimeEndpointGeneration() && Object.values(useConversationOrganizationStore.getState().failed).some(command => 'id' in command.operation && command.operation.id === current.id)) setEditor(value => value?.id === current.id ? null : value);
        throw error;
      }
    });
  };
  const firstRootConversation = shown.findIndex(node => node.conversation);
  const lastContainer = shown.reduce((last, node, index) => node.container ? index : last, -1);
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t('organization.shared')}>
    <div className="flex min-h-9 items-center justify-between gap-2 px-3 pb-1">
      {preference.focus ? <button type="button" className="flex min-w-0 items-center gap-1 typography-micro text-muted-foreground hover:text-foreground" title={location(preference.focus)} onClick={() => setPreference({ focus: null })}><Icon name="arrow-left-s" className="size-3 shrink-0" /><span className="truncate">{location(preference.focus)}</span></button> : <div className="organization-tabs" role="tablist" aria-label={t('organization.directory')}><button type="button" role="tab" aria-selected={recent} onClick={() => setPreference({ view: 'recent' })}>{t('organization.recent')}</button><button type="button" role="tab" aria-selected={!recent} onClick={() => setPreference({ view: 'classified' })}>{t('organization.classified')}</button></div>}
      <div className="flex shrink-0 items-center">{selectedEntry.entry && <button type="button" className="organization-icon-button" title={t('organization.locate')} aria-label={t('organization.locate')} onClick={() => { setPreference({ focus: selectedEntry.entry!.position.containerId, view: 'classified' }); onSearchReset?.(); }}><Icon name="target" className="size-3.5" /></button>}{!archived && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="organization-icon-button" disabled={!snapshot} aria-label={t('organization.add')}><Icon name="add" className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => create(preference.focus)}><Icon name="folder-add" className="size-4" />{t('organization.newGroupMenu')}</DropdownMenuItem><DropdownMenuItem onClick={() => setProjectCreate({ parentId: preference.focus })}><Icon name="code-box" className="size-4" />{t('organization.addProject')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}</div>
    </div>
    {projectCreate && <ProjectCreateDialog open parentContainerId={projectCreate.parentId} onOpenChange={open => { if (!open) { setProjectCreate(null); void refreshConversationOrganization(); } }} />}
    {state.error && <p role="alert" className="px-3 py-2 typography-meta text-destructive">{state.error} <button type="button" className="underline" onClick={() => act(refreshConversationOrganization)}>{t('organization.refresh')}</button></p>}
    <OrganizationOperationFeedback pendingKeys={new Set(Object.keys(state.pending))} failed={Object.values(state.failed)} intents={metadataIntents} onCheck={original => act(() => submitOrganization(original.operation, original))} onRetry={key => act(() => submitOrganizationMetadata([], key))} name={reference => snapshot?.conversations.find(entry => entry.conversation.kind === reference.kind && entry.conversation.id === reference.id)?.title || (reference.kind === 'native' ? threadById.get(reference.id)?.title : externalById.get(reference.id)?.title) || t('organization.untitled')} />
    {state.loading && !snapshot && <p role="status" className="px-3 typography-meta text-muted-foreground">{t('organization.loading')}</p>}
    {(selection.size > 0 || selectionMode) && <div className="mx-2 mb-1 flex flex-wrap items-center gap-1 rounded-lg bg-interactive-hover px-1 py-1 typography-meta"><span className="mr-auto pl-1 text-muted-foreground">{t('organization.selectedCount', { count: selection.size })}</span><Button size="sm" variant="ghost" disabled={!selectedNodes.length} onClick={() => chooseMove(selectedNodes)}>{t('organization.move')}</Button><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="organization-icon-button" aria-label={t('organization.actions', { name: t('organization.selectedCount', { count: selection.size }) })}><Icon name="more" className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem disabled={metadataBusy(selectedNodes) || !selectedNodes.some(node => node.conversation)} onClick={() => act(() => metadata(selectedNodes.filter(node => node.conversation), { archived: !archived }))}>{t(archived ? 'organization.restore' : 'organization.archive')}</DropdownMenuItem><DropdownMenuItem data-variant="destructive" disabled={metadataBusy(selectedNodes) || !selectedNodes.some(node => node.conversation)} onClick={() => requestDelete(selectedNodes.filter(node => node.conversation))}>{t('organization.deleteSelected')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu><button type="button" className="organization-icon-button" aria-label={t('organization.endSelection')} onClick={() => { setSelection(new Set()); onExitSelection?.(); }}><Icon name="close" className="size-3.5" /></button></div>}
    <DndContext sensors={sensors} collisionDetection={args => args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)} onDragStart={event => setDrag(event.active.data.current as OrganizationNode)} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setDrag(null); setDropLabel(''); }}>
      <FlipList containerRef={list} layoutKey={listLayoutKey} instantKey={query} className="relative min-h-0 flex-1 overflow-auto px-2 pb-3"><div role="tree" aria-label={t('organization.directory')}>{shown.map((node, index) => <React.Fragment key={node.key}>{!recent && !query.trim() && !preference.focus && index === firstRootConversation && index > lastContainer && <p className="mb-1 mt-3 px-1.5 typography-micro text-muted-foreground">{t('organization.uncategorized')}</p>}{render(node)}</React.Fragment>)}{pageControls(viewQuery)}<DropTarget id="root:end" disabled={recent || !!query.trim() || !canDrop(preference.focus)} drop={{ reorder: true, parentId: preference.focus, before: null, label: t('organization.currentEnd') }}><div className="min-h-8 px-2 py-2 typography-micro text-muted-foreground">{shown.length || !state.pages[organizationQueryKey(viewQuery)]?.snapshot ? '' : t(archived ? 'organization.emptyArchive' : 'organization.empty')}{drag && t('organization.dropEnd')}</div></DropTarget></div></FlipList>
      <DragOverlay>{drag ? <div className="rounded-lg border border-border bg-popover px-3 py-2 typography-ui-label shadow-md">{name(drag)}{dropLabel && <div className="typography-meta text-muted-foreground">{dropLabel}</div>}</div> : null}</DragOverlay>
    </DndContext>
    <span role="status" aria-live="polite" className="sr-only">{dropLabel}</span>
    <OrganizationGroupDialog value={editor} onChange={setEditor} location={t('organization.groupLocation', { path: location(editor?.parentId ?? null) })} pending={!!editor && Object.values(state.pending).some(command => 'id' in command.operation && command.operation.id === editor.id)} onSubmit={saveGroup} />
    {namedSnapshot && <Dialog open={!!move} onOpenChange={open => { if (!open) setMove(null); }}><DialogContent className="max-w-[420px] gap-5 p-5"><DialogHeader className="text-left"><DialogTitle className="text-[15px] font-medium">{t('organization.moveTo')}</DialogTitle><DialogDescription className="typography-meta">{moveContents?.length === 1 ? name(moveContents[0]) : t('organization.selectedCount', { count: moveContents?.length ?? 0 })}</DialogDescription></DialogHeader><form className="space-y-5" onSubmit={event => { event.preventDefault(); if (move) act(() => moveNodes(move, { parentId: moving || null, before: null, label: '' })); }}><OrganizationDestinationPicker value={moving} onChange={setMoving} snapshot={namedSnapshot} excluded={moveContents?.flatMap(node => node.container ? [node.container.id] : []) ?? []} disabled={movingBusy} /><DialogFooter className="flex-row"><Button type="button" variant="ghost" size="sm" onClick={() => setMove(null)}>{t('organization.cancel')}</Button><Button type="submit" size="sm" disabled={movingBusy}>{t(movingBusy ? 'organization.moving' : 'organization.moveHere')}</Button></DialogFooter></form></DialogContent></Dialog>}
    <Dialog open={!!rename} onOpenChange={open => { if (!open) setRename(null); }}><DialogContent className="max-w-[360px] p-5"><DialogHeader><DialogTitle className="text-[15px] font-medium">{t('organization.rename')}</DialogTitle></DialogHeader>{renameContents && <form className="space-y-5" onSubmit={event => { event.preventDefault(); if (!rename) return; const original = rename; act(async () => { try { await metadata([original.node], { title: original.title }); }
      finally { setRename(value => value === original ? null : value); } }); }}><Input autoFocus aria-label={t('organization.conversationName')} value={renameContents.title} onChange={event => setRename({ ...renameContents, title: event.target.value })} onKeyDown={event => { if (composingKey(event)) return; if (event.key === 'Escape') setRename(null); }} /><DialogFooter className="flex-row"><Button type="button" variant="ghost" size="sm" onClick={() => setRename(null)}>{t('organization.cancel')}</Button><Button type="submit" size="sm" disabled={metadataBusy([renameContents.node]) || !renameContents.title.trim()}>{t('organization.save')}</Button></DialogFooter></form>}</DialogContent></Dialog>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="max-w-sm gap-5 p-5"><DialogHeader><DialogTitle className="text-[15px] font-medium">{confirmationContents?.title}</DialogTitle><DialogDescription>{confirmationContents?.description}</DialogDescription></DialogHeader><DialogFooter className="flex-row"><Button type="button" variant="ghost" size="sm" onClick={() => setConfirmation(null)}>{t('organization.cancel')}</Button><Button type="button" size="sm" variant="destructive" disabled={confirming === confirmation} onClick={() => { if (!confirmation) return; const original = confirmation; setConfirming(original); act(async () => { try { await original.run(); setConfirmation(value => value === original ? null : value); } finally { setConfirming(value => value === original ? null : value); } }); }}>{confirmationContents?.action}</Button></DialogFooter></DialogContent></Dialog>
  </section>;
});
