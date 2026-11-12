import type { ConversationOrganizationSnapshot, ConversationOrganizationContainer, ConversationOrganizationEntry, ConversationOrganizationObject } from '@varin/application-client';

export const organizationObjectKey = (object: ConversationOrganizationObject): string => JSON.stringify([object.kind, object.id]);
export type OrganizationNode = {
  key: string; object: ConversationOrganizationObject; parentId: string | null; order: number;
  container?: ConversationOrganizationContainer; conversation?: ConversationOrganizationEntry;
  children: OrganizationNode[];
};
/** Recent task ancestry follows dispatch, independently of explicit category moves. */
export function projectRecentConversations(snapshot: ConversationOrganizationSnapshot, options: { archived?: boolean; botId?: string; excludeBotConversations?: boolean } = {}): OrganizationNode[] {
  const nodes = new Map<string, OrganizationNode>();
  snapshot.conversations.forEach((entry, order) => {
    if (options.excludeBotConversations && entry.origin.directBotId || entry.archived !== Boolean(options.archived) || options.botId && entry.origin.botId !== options.botId && entry.origin.directBotId !== options.botId) return;
    const key = organizationObjectKey(entry.conversation);
    nodes.set(key, { key, object: entry.conversation, parentId: entry.position.containerId, order, conversation: entry, children: [] });
  });
  const roots: OrganizationNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.conversation!.origin.conversation;
    (parent && nodes.get(organizationObjectKey(parent))?.children || roots).push(node);
  }
  return roots;
}
/** Navigation inheritance does not modify execution ancestry. Explicit children become independent rows. */
export function projectOrganization(snapshot: ConversationOrganizationSnapshot, options: { query?: string; botId?: string; archived?: boolean; flat?: boolean; excludeBotConversations?: boolean } = {}): OrganizationNode[] {
  const containers = new Map<string, OrganizationNode>();
  const conversations = new Map<string, OrganizationNode>();
  const roots: OrganizationNode[] = [];
  for (const container of snapshot.containers) containers.set(container.id, { key: organizationObjectKey({ kind: 'container', id: container.id }), object: { kind: 'container', id: container.id }, parentId: container.parentId, order: container.order, container, children: [] });
  for (const entry of snapshot.conversations) {
    if (options.excludeBotConversations && entry.origin.directBotId) continue;
    if (entry.archived !== Boolean(options.archived) || options.botId && entry.origin.botId !== options.botId && entry.origin.directBotId !== options.botId) continue;
    conversations.set(organizationObjectKey(entry.conversation), { key: organizationObjectKey(entry.conversation), object: entry.conversation, parentId: entry.position.containerId, order: entry.position.order, conversation: entry, children: [] });
  }
  for (const node of containers.values()) (node.parentId && containers.get(node.parentId)?.children || roots).push(node);
  for (const node of conversations.values()) {
    const position = node.conversation!.position;
    const parent = !options.flat && !position.explicit && position.inheritedFrom ? conversations.get(organizationObjectKey(position.inheritedFrom)) : undefined;
    (parent?.children || node.parentId && containers.get(node.parentId)?.children || roots).push(node);
  }
  const needle = options.query?.trim().toLocaleLowerCase();
  const pageKeys = snapshot.items ? new Set(snapshot.items.map(organizationObjectKey)) : null;
  const seen = new Set<string>();
  const visit = (nodes: OrganizationNode[], ancestorMatches = false): OrganizationNode[] => nodes.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)).flatMap(node => {
    if (seen.has(node.key)) return [];
    seen.add(node.key);
    const containerMatches = Boolean(!pageKeys && needle && node.container?.name?.toLocaleLowerCase().includes(needle));
    const children = visit(node.children, ancestorMatches || containerMatches);
    const hit = !needle || (pageKeys ? pageKeys.has(node.key) : ancestorMatches || (node.container?.name ?? node.conversation?.title ?? '').toLocaleLowerCase().includes(needle));
    // A search keeps ancestors, not all siblings. A Bot scope omits unrelated empty containers.
    if (!hit && !children.length || options.botId && node.container && !children.length && !pageKeys?.has(node.key)) return [];
    return [{ ...node, children }];
  });
  return visit(roots);
}
export function organizationContainerPath(snapshot: ConversationOrganizationSnapshot, id: string | null): ConversationOrganizationContainer[] {
  const byId = new Map(snapshot.containers.map(container => [container.id, container]));
  const path: ConversationOrganizationContainer[] = [], seen = new Set<string>();
  while (id && !seen.has(id)) { seen.add(id); const container = byId.get(id); if (!container) break; path.unshift(container); id = container.parentId; }
  return path;
}
export function nearestOrganizationProject(snapshot: ConversationOrganizationSnapshot, id: string | null): string | null {
  return organizationContainerPath(snapshot, id).reverse().find(container => container.kind === 'project')?.projectId ?? null;
}

/** A navigation drop cannot target its own selection or place a container below itself. */
export function organizationDropAllowed(snapshot: ConversationOrganizationSnapshot, items: readonly OrganizationNode[], target: { parentId: string | null; before: ConversationOrganizationObject | null }): boolean {
  const selected = new Set(items.map(item => item.key));
  if (target.before && selected.has(organizationObjectKey(target.before))) return false;
  const ancestors = new Set(organizationContainerPath(snapshot, target.parentId).map(container => container.id));
  return items.every(item => !item.container || !ancestors.has(item.container.id));
}
