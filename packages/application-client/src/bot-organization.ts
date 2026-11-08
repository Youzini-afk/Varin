import type { BotSummary } from './bots.js';

/** Host-owned navigation metadata. Grouping does not alter a Bot profile or its work. */
export interface BotGroup { id: string; name: string; botIds: string[] }
export interface BotOrganization { revision: number; groups: BotGroup[]; ungrouped: string[] }
export type BotOrganizationChange =
  | { kind: 'create'; id: string; name: string }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'remove'; id: string }
  | { kind: 'move-group'; id: string; beforeId: string | null }
  | { kind: 'move-bot'; botId: string; groupId: string | null; beforeId: string | null };
export interface BotOrganizationAPI {
  read(signal?: AbortSignal): Promise<BotOrganization>;
  update(input: { expectedRevision: number; change: BotOrganizationChange }): Promise<BotOrganization>;
}
export const emptyBotOrganization = (): BotOrganization => ({ revision: 0, groups: [], ungrouped: [] });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

export function parseBotOrganization(value: unknown): BotOrganization {
  if (!object(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.groups) || !Array.isArray(value.ungrouped)) throw new Error('Invalid Bot organization');
  const ids = new Set<string>(), bots = new Set<string>();
  const members = (values: unknown): string[] => {
    if (!Array.isArray(values)) throw new Error('Invalid Bot group members');
    return values.map(id => { if (!text(id) || bots.has(id)) throw new Error('Invalid or duplicate Bot group member'); bots.add(id); return id; });
  };
  const groups = value.groups.map(group => {
    if (!object(group) || !text(group.id) || !text(group.name) || ids.has(group.id)) throw new Error('Invalid or duplicate Bot group');
    ids.add(group.id);
    return { id: group.id, name: group.name, botIds: members(group.botIds) };
  });
  return { revision: Number(value.revision), groups, ungrouped: members(value.ungrouped) };
}

export function parseBotOrganizationChange(value: unknown): BotOrganizationChange {
  if (!object(value)) throw new Error('Invalid Bot organization change');
  const before = value.beforeId === null || text(value.beforeId);
  switch (value.kind) {
    case 'create': case 'rename':
      if (text(value.id) && text(value.name)) return { kind: value.kind, id: value.id, name: value.name.trim() };
      break;
    case 'remove': if (text(value.id)) return { kind: value.kind, id: value.id }; break;
    case 'move-group': if (text(value.id) && before) return { kind: value.kind, id: value.id, beforeId: value.beforeId as string | null }; break;
    case 'move-bot':
      if (text(value.botId) && (value.groupId === null || text(value.groupId)) && before) return { kind: value.kind, botId: value.botId, groupId: value.groupId as string | null, beforeId: value.beforeId as string | null };
  }
  throw new Error('Invalid Bot organization change');
}

/** Shared by optimistic presentation and the Host's revision-checked commit. */
export function applyBotOrganizationChange(current: BotOrganization, input: BotOrganizationChange, knownBotIds: readonly string[]): BotOrganization {
  const change = parseBotOrganizationChange(input), known = new Set(knownBotIds);
  const next: BotOrganization = { revision: current.revision, groups: current.groups.map(group => ({ ...group, botIds: group.botIds.filter(id => known.has(id)) })), ungrouped: current.ungrouped.filter(id => known.has(id)) };
  const assigned = new Set([...next.ungrouped, ...next.groups.flatMap(group => group.botIds)]);
  next.ungrouped.push(...knownBotIds.filter(id => !assigned.has(id)));
  const group = (id: string) => { const found = next.groups.find(value => value.id === id); if (!found) throw new Error('Bot group no longer exists'); return found; };
  const insert = <T>(rows: T[], item: T, beforeId: string | null, idOf: (value: T) => string) => {
    const index = beforeId === null ? rows.length : rows.findIndex(value => idOf(value) === beforeId);
    if (index < 0) throw new Error('The destination has changed');
    rows.splice(index, 0, item);
  };
  switch (change.kind) {
    case 'create':
      if (next.groups.some(value => value.id === change.id)) throw new Error('Bot group already exists');
      next.groups.push({ id: change.id, name: change.name, botIds: [] }); break;
    case 'rename': group(change.id).name = change.name; break;
    case 'remove':
      next.ungrouped.push(...group(change.id).botIds);
      next.groups = next.groups.filter(value => value.id !== change.id); break;
    case 'move-group': {
      const moved = group(change.id);
      if (change.beforeId === change.id) break;
      next.groups = next.groups.filter(value => value.id !== change.id);
      insert(next.groups, moved, change.beforeId, value => value.id); break;
    }
    case 'move-bot': {
      if (!known.has(change.botId)) throw new Error('Bot no longer exists');
      const target = change.groupId === null ? next.ungrouped : group(change.groupId).botIds;
      if (change.beforeId === change.botId && target.includes(change.botId)) break;
      for (const rows of [next.ungrouped, ...next.groups.map(value => value.botIds)]) { const index = rows.indexOf(change.botId); if (index >= 0) rows.splice(index, 1); }
      insert(target, change.botId, change.beforeId, value => value); break;
    }
  }
  return next;
}

export function botOrganizationSections(bots: readonly BotSummary[], organization: BotOrganization) {
  const byId = new Map(bots.map(bot => [bot.id, bot])), assigned = new Set(organization.groups.flatMap(group => group.botIds));
  const ordered = (ids: string[], rest: readonly BotSummary[] = []) => {
    const present = new Set(ids);
    return [...ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), ...rest.filter(bot => !present.has(bot.id))]
      .sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt));
  };
  return [
    { group: null, bots: ordered(organization.ungrouped, bots.filter(bot => !assigned.has(bot.id))) },
    ...organization.groups.map(group => ({ group, bots: ordered(group.botIds) })),
  ];
}
