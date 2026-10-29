import { isAgentAvatarId } from '@varin/protocol';
import { COMPANION_TEAM_VISIBLE_LIMIT, type DesktopCompanionTeam } from '@varin/application-client/desktop';
import { companionWorldRect } from './companion-window.js';
type Bounds = ReturnType<typeof companionWorldRect>;

import type { DesktopCompanionScene } from '@varin/application-client/desktop';

export type CompanionSceneDescriptor = DesktopCompanionScene;
export type CompanionSceneKind = Exclude<DesktopCompanionScene['kind'], null>;
export interface CompanionSceneViewport { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number }
export interface CompanionSceneOwner {
  id: number; isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean;
  isAlwaysOnTop(): boolean; getContentBounds(): Bounds;
}
export interface CompanionSceneWindow {
  isDestroyed(): boolean; close(): void; hide(): void; showInactive(): void;
  setBounds(bounds: Bounds): void; setAlwaysOnTop(value: boolean): void;
  publish(value: CompanionScenePayload): Promise<void>; onReady(callback: () => void): void;
}
export interface CompanionScenePayload {
  descriptor: CompanionSceneDescriptor;
  layout: { character: Bounds; visible: Bounds };
}
const kinds = new Set(['reading','editing','searching','dispatch','question','permission','organize','verify','status']);
/** Narrow presentation data only: no renderer-provided markup, URL, task content or command. */
export function readCompanionSceneDescriptor(value: unknown): CompanionSceneDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing scene descriptor');
  const d = value as Record<string, unknown>;
  if (!Number.isSafeInteger(d.revision) || (d.revision as number) < 0
    || typeof d.scope !== 'string' || d.scope.length > 200
    || (d.kind !== null && !kinds.has(String(d.kind)))
    || !['active','resolve','withdraw'].includes(String(d.phase))
    || ![null,'allowed','denied','answered'].includes(d.outcome as null | string)
    || !(d.count === null || Number.isSafeInteger(d.count) && (d.count as number) >= 0 && (d.count as number) <= 99)
    || !['transition','engaged','present','read','page-turn','type','review','revise','scan-left','scan-right','select','split','dispatch-left','dispatch-right','watch','ask','offer','attend','acknowledge','organize-align','organize-select','verify-scan','verify-compare'].includes(String(d.cue))
    || !(d.cueInstance === undefined || Number.isSafeInteger(d.cueInstance) && (d.cueInstance as number) >= 0)
    || typeof d.suppressed !== 'boolean' || typeof d.reducedMotion !== 'boolean' || typeof d.menuOpen !== 'boolean') throw new Error('Invalid scene descriptor');
  let team: DesktopCompanionTeam | undefined;
  if (d.team !== undefined) {
    const value = d.team as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.members) || value.members.length > COMPANION_TEAM_VISIBLE_LIMIT
      || !(value.overflowCount === null || Number.isSafeInteger(value.overflowCount) && (value.overflowCount as number) >= 0)) throw new Error('Invalid companion team');
    const keys = new Set<string>();
    const members: DesktopCompanionTeam['members'] = value.members.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid companion team member');
      const member = raw as Record<string, unknown>;
      if (typeof member.key !== 'string' || !member.key || member.key.length > 200 || keys.has(member.key) || !isAgentAvatarId(member.avatar)
        || !['preparing','running','waiting','settling','failed','leaving'].includes(String(member.state))) throw new Error('Invalid companion team member');
      keys.add(member.key);
      return { key: member.key, avatar: member.avatar, state: member.state as DesktopCompanionTeam['members'][number]['state'] };
    });
    team = { members, overflowCount: value.overflowCount as number | null };
  }
  if (d.kind === 'status' ? !['queued','external','retry','failure','cancelling','disconnected','synchronizing','uncertain'].includes(String(d.status)) : d.status !== undefined) throw new Error('Invalid scene status');
  if (d.outcome !== null && (d.phase !== 'resolve' || (d.outcome === 'answered' ? d.kind !== 'question' : d.kind !== 'permission'))) throw new Error('Scene outcome does not match its presentation');
  return { revision: d.revision as number, scope: d.scope, kind: d.kind as CompanionSceneKind | null,
    phase: d.phase as CompanionSceneDescriptor['phase'], outcome: d.outcome as CompanionSceneDescriptor['outcome'],
    ...(team ? { team } : {}), ...(d.status === undefined ? {} : { status: d.status as NonNullable<CompanionSceneDescriptor['status']> }), count: d.count as number | null, ...(d.cueInstance === undefined ? {} : { cueInstance: d.cueInstance as number }), cue: d.cue as CompanionSceneDescriptor['cue'], suppressed: d.suppressed, reducedMotion: d.reducedMotion, menuOpen: d.menuOpen };
}

export function companionSceneLayout(content: Bounds, viewport: unknown, workArea: Bounds) {
  const character = companionWorldRect(content, viewport);
  // Preserve the character's native anchor. Additional space is decorative only;
  // the bottom ends at the character canvas, above the existing status caption.
  const width = Math.round(character.width * 1.45), height = Math.round(character.height * 1.2);
  const bounds = { x: character.x - Math.round((width-character.width)/2), y: character.y-(height-character.height), width, height };
  const left = Math.max(bounds.x,workArea.x), top = Math.max(bounds.y,workArea.y);
  const right = Math.min(bounds.x+width,workArea.x+workArea.width), bottom = Math.min(bounds.y+height,workArea.y+workArea.height);
  return { bounds, layout: {
    character: { x: (character.x-bounds.x)/width, y: (character.y-bounds.y)/height, width: character.width/width, height: character.height/height },
    visible: { x: (left-bounds.x)/width, y: (top-bounds.y)/height, width: Math.max(0,right-left)/width, height: Math.max(0,bottom-top)/height },
  } };
}

type SceneEntry = {
  owner: CompanionSceneOwner; window: CompanionSceneWindow; descriptor: CompanionSceneDescriptor;
  viewport: CompanionSceneViewport; receivedAt: number; ready: boolean; blocked: boolean; queue: Promise<void>; lastPayload?: string;
};
/** One inert surface per companion. Its owner is the only presentation source. */
export class CompanionSceneWindows {
  private readonly entries = new Map<number, SceneEntry>();
  constructor(private readonly create: (bounds: Bounds) => CompanionSceneWindow,
    private readonly workArea: (bounds: Bounds) => Bounds) {}

  update(owner: CompanionSceneOwner, raw: unknown, viewport: CompanionSceneViewport): void {
    const descriptor = readCompanionSceneDescriptor(raw);
    if (owner.isDestroyed()) { this.clear(owner.id); return; }
    const geometry = companionSceneLayout(owner.getContentBounds(), viewport, this.workArea(owner.getContentBounds()));
    let entry = this.entries.get(owner.id);
    if (entry?.window.isDestroyed()) { this.clear(owner.id); entry = undefined; }
    if (entry && descriptor.revision <= entry.descriptor.revision) return;
    if (!entry) {
      if (descriptor.kind === null && !descriptor.team?.members.length) return;
      entry = { owner, window: this.create(geometry.bounds), descriptor, viewport: { ...viewport }, receivedAt: Date.now(), ready: false, blocked: false, queue: Promise.resolve() };
      this.entries.set(owner.id, entry);
      const created = entry;
      entry.window.onReady(() => {
        if (this.entries.get(owner.id) !== created) return;
        created.ready = true; this.refresh(owner.id);
      });
    } else {
      if (entry.descriptor.scope !== descriptor.scope || entry.descriptor.kind !== descriptor.kind || entry.descriptor.phase !== descriptor.phase || entry.descriptor.outcome !== descriptor.outcome) entry.receivedAt = Date.now();
      entry.descriptor = descriptor; entry.viewport = { ...viewport };
    }
    this.refresh(owner.id);
  }

  block(ownerId: number, blocked: boolean): void {
    const entry = this.entries.get(ownerId); if (!entry) return;
    entry.blocked = blocked; this.refresh(ownerId);
  }

  refresh(ownerId: number): void {
    const entry = this.entries.get(ownerId); if (!entry) return;
    if (entry.owner.isDestroyed() || entry.window.isDestroyed()) { this.clear(ownerId); return; }
    // Native input suppression happens synchronously, before queued renderer work.
    if (!this.visible(entry)) entry.window.hide();
    if (!entry.ready) return;
    entry.queue = entry.queue.catch(() => {}).then(async () => {
      if (this.entries.get(ownerId) !== entry || entry.window.isDestroyed() || entry.owner.isDestroyed()) return;
      // Publish suppression even when native visibility events are throttled or disabled.
      // The decorative renderer must stop its own RAF, not rely on document.hidden.
      if (!this.visible(entry)) entry.window.hide();
      const { bounds, layout } = companionSceneLayout(entry.owner.getContentBounds(), entry.viewport, this.workArea(entry.owner.getContentBounds()));
      entry.window.setBounds(bounds); entry.window.setAlwaysOnTop(entry.owner.isAlwaysOnTop());
      const descriptor = { ...entry.descriptor, suppressed: !this.visible(entry) };
      const payload = { descriptor, layout }, key = JSON.stringify(payload);
      if (entry.lastPayload !== key) {
        await entry.window.publish(payload);
        entry.lastPayload = key;
      }
      if (this.entries.get(ownerId) !== entry || entry.window.isDestroyed()) return;
      if (this.visible(entry) && entry.descriptor.revision === descriptor.revision) entry.window.showInactive();
      else entry.window.hide();
    }).catch(() => { if (this.entries.get(ownerId) === entry) this.clear(ownerId); });
  }
  private visible(entry: SceneEntry): boolean {
    const age = Date.now() - entry.receivedAt;
    const expired = entry.descriptor.phase === 'withdraw' ? age >= 600 : entry.descriptor.phase === 'resolve' && age >= 900;
    const hasTeam = !!entry.descriptor.team?.members.length;
    return (hasTeam || !expired) && !entry.blocked && !entry.descriptor.suppressed && (entry.descriptor.kind !== null || hasTeam)
      && !entry.owner.isDestroyed() && entry.owner.isVisible() && !entry.owner.isMinimized();
  }
  clear(ownerId: number): void {
    const entry = this.entries.get(ownerId); if (!entry) return;
    this.entries.delete(ownerId); if (!entry.window.isDestroyed()) entry.window.close();
  }
  clearAll(): void { for (const id of this.entries.keys()) this.clear(id); }
}
