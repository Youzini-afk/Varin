import { expect, it, vi } from 'vitest';
import { CompanionSceneWindows, companionSceneLayout, readCompanionSceneDescriptor, type CompanionSceneDescriptor, type CompanionScenePayload } from './companion-scene';

const descriptor = (revision: number, extra: Partial<CompanionSceneDescriptor> = {}): CompanionSceneDescriptor => ({ revision, scope: 'host/thread/branch', kind: 'reading', phase: 'active', outcome: null, count: null, suppressed: false, reducedMotion: false, menuOpen: false, cue: 'engaged', ...extra });
const viewport = { x: 0, y: 0, width: 360, height: 360, viewportWidth: 360, viewportHeight: 480 };
const area = { x: 0, y: 0, width: 1280, height: 800 };
function fixture() {
  const owner = { id: 7, closed: false, visible: true, minimized: false, pinned: false, bounds: { x: 100, y: 80, width: 360, height: 480 },
    isDestroyed() { return this.closed; }, isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    isAlwaysOnTop() { return this.pinned; }, getContentBounds() { return this.bounds; } };
  const windows: { closed: boolean; visible: boolean; pinned: boolean; bounds: typeof area; ready?: () => void; payloads: CompanionScenePayload[] }[] = [];
  let release: (() => void) | undefined;
  const manager = new CompanionSceneWindows(bounds => {
    const win = { closed: false, visible: false, pinned: false, bounds, payloads: [] as CompanionScenePayload[] }; windows.push(win);
    return { isDestroyed: () => win.closed, close: () => { win.closed = true; win.visible = false; }, hide: () => { win.visible = false; },
      showInactive: () => { win.visible = true; }, setBounds: value => { win.bounds = value; }, setAlwaysOnTop: value => { win.pinned = value; },
      onReady: cb => { (win as typeof windows[number]).ready = cb; },
      publish: async payload => { win.payloads.push(payload); if (release === undefined) return; await new Promise<void>(resolve => { release = resolve; }); },
    };
  }, () => area);
  return { owner, windows, manager, stall: () => { release = () => {}; }, release: () => { release?.(); release = undefined; } };
}
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };

it('uses one inert scene, preserves character DIP anchor and follows visibility and pin state', async () => {
  const f = fixture(); f.manager.update(f.owner, descriptor(1), viewport);
  expect(f.windows[0]?.visible).toBe(false);
  f.windows[0]?.ready?.(); await flush(); expect(f.windows[0]?.visible).toBe(true);
  const geometry = companionSceneLayout(f.owner.bounds, viewport, area);
  expect(geometry.bounds.width).toBe(522); expect(geometry.bounds.y + geometry.bounds.height).toBe(440);
  expect(geometry.bounds.x + geometry.layout.character.x * geometry.bounds.width).toBe(100);
  f.owner.bounds.x = 220; f.owner.pinned = true; f.manager.refresh(f.owner.id); await flush();
  expect(f.windows).toHaveLength(1); expect(f.windows[0]?.bounds.x).toBe(139); expect(f.windows[0]?.pinned).toBe(true);
  f.owner.visible = false; f.manager.refresh(f.owner.id); expect(f.windows[0]?.visible).toBe(false);
  await flush(); expect(f.windows[0]?.visible).toBe(false);
  expect(f.windows[0]?.payloads.at(-1)?.descriptor.suppressed).toBe(true);
  const hiddenCount = f.windows[0]!.payloads.length;
  f.manager.refresh(f.owner.id); await flush(); expect(f.windows[0]!.payloads.length).toBe(hiddenCount);
  f.owner.visible = true; f.manager.refresh(f.owner.id); await flush(); expect(f.windows[0]?.visible).toBe(true);
  expect(f.windows[0]?.payloads.at(-1)?.descriptor.suppressed).toBe(false);
  f.manager.clearAll(); expect(f.windows[0]?.closed).toBe(true);
});

it('ignores stale data, suppresses immediately during drag and cannot resurrect after late render or close', async () => {
  const f = fixture(); f.manager.update(f.owner, descriptor(10), viewport); f.windows[0]?.ready?.(); await flush();
  f.manager.update(f.owner, descriptor(9, { kind: 'permission' }), viewport); await flush();
  expect(f.windows[0]?.payloads.at(-1)?.descriptor.kind).toBe('reading');
  f.stall(); f.manager.update(f.owner, descriptor(11, { kind: 'editing' }), viewport); await flush();
  f.manager.block(f.owner.id, true); expect(f.windows[0]?.visible).toBe(false);
  f.release(); await flush(); expect(f.windows[0]?.visible).toBe(false);
  f.manager.update(f.owner, descriptor(12, { suppressed: true }), viewport); f.manager.block(f.owner.id, false); await flush();
  expect(f.windows[0]?.visible).toBe(false);
  f.manager.update(f.owner, descriptor(13), viewport); await flush(); expect(f.windows[0]?.visible).toBe(true);
  f.manager.clear(f.owner.id); f.windows[0]?.ready?.(); await flush(); expect(f.windows[0]?.closed).toBe(true);
  expect(() => f.manager.update(f.owner, descriptor(14, { outcome: 'allowed' }), viewport)).toThrow('outcome');
  expect(() => f.manager.update(f.owner, descriptor(14, {kind:'status'}), viewport)).toThrow('status');
  expect(() => f.manager.update(f.owner, descriptor(14, {kind:'status',status:'retry',phase:'resolve',outcome:'allowed'}), viewport)).toThrow('outcome');
  expect(() => f.manager.update(f.owner, descriptor(14), { ...viewport, width: 999 })).toThrow('viewport');
});

it('does not replay an expired short-event tail when the decorative window loads late', async () => {
  let now = 1_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const f = fixture();
    f.manager.update(f.owner, descriptor(1), viewport);
    f.manager.update(f.owner, descriptor(2, { phase: 'withdraw' }), viewport);
    now += 700;
    f.windows[0]?.ready?.(); await flush();
    expect(f.windows[0]?.visible).toBe(false);
    f.manager.update(f.owner, descriptor(3, { phase: 'withdraw', menuOpen: true }), viewport); await flush();
    expect(f.windows[0]?.visible).toBe(false);
    f.manager.update(f.owner, descriptor(4, { kind: 'permission' }), viewport); await flush();
    expect(f.windows[0]?.visible).toBe(true);
  } finally { clock.mockRestore(); }
});


it('admits only bounded local avatar identities, never renderer markup or duplicate child seats', () => {
  const team = { members: [{ key: 'scope-child-1', avatar: 'slope-lilac' as const, state: 'running' as const }], overflowCount: 2 };
  expect(readCompanionSceneDescriptor(descriptor(1, { kind: 'dispatch', team })).team).toEqual(team);
  for (const invalid of [
    { ...team, members: [{ ...team.members[0], avatar: 'https://remote.invalid/avatar.svg' }] },
    { ...team, members: [team.members[0], team.members[0]] },
    { ...team, overflowCount: -1 },
    { ...team, members: [0,1,2,3].map(n => ({ ...team.members[0], key: String(n) })) },
  ]) expect(() => readCompanionSceneDescriptor({ ...descriptor(2), team: invalid })).toThrow('team');
});


it('keeps factual child seats across primary changes and admits a team-only quiet surface', async () => {
  const f=fixture();
  const team={ members:[{key:'same-child',avatar:'slope-lilac' as const,state:'running' as const}],overflowCount:0 };
  f.manager.update(f.owner,descriptor(1,{kind:null,phase:'withdraw',team}),viewport);
  f.windows[0]?.ready?.();await flush();expect(f.windows[0]?.visible).toBe(true);
  f.manager.update(f.owner,descriptor(2,{kind:'reading',team}),viewport);await flush();
  expect(f.windows).toHaveLength(1);expect(f.windows[0]?.payloads.at(-1)?.descriptor.team).toEqual(team);
  f.manager.block(f.owner.id,true);await flush();expect(f.windows[0]?.visible).toBe(false);
  f.manager.block(f.owner.id,false);await flush();expect(f.windows[0]?.visible).toBe(true);
  f.manager.update(f.owner,descriptor(3,{kind:null,phase:'withdraw',team:{members:[],overflowCount:0},suppressed:true}),viewport);await flush();
  expect(f.windows[0]?.visible).toBe(false);
});


it('allows only the existing same-scope final spirit a bounded neutral departure', async () => {
  vi.useFakeTimers();
  try {
    const f=fixture(), team={members:[{key:'member-1',avatar:'slope-lilac' as const,state:'running' as const}],overflowCount:0};
    f.manager.update(f.owner,descriptor(1,{kind:null,team}),viewport);f.windows[0]?.ready?.();await flush();
    f.manager.update(f.owner,descriptor(2,{kind:null,team:{members:[],overflowCount:0}}),viewport);await flush();
    expect(f.windows[0]?.visible).toBe(true);
    expect(f.windows[0]?.payloads.at(-1)?.descriptor.team?.members).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    f.manager.update(f.owner,descriptor(3,{kind:null,team}),viewport);await flush();
    await vi.advanceTimersByTimeAsync(500);await flush();expect(f.windows[0]?.visible).toBe(true);
    f.manager.update(f.owner,descriptor(4,{kind:null,team:{members:[],overflowCount:0}}),viewport);await flush();
    await vi.advanceTimersByTimeAsync(600);await flush();expect(f.windows[0]?.visible).toBe(false);
    f.manager.clearAll();
  } finally { vi.useRealTimers(); }
});

it('accepts only bounded portfolio identities and independent visible-project teams', () => {
  const portfolio = { mode: 'inspection', projects: [{ key: 'project-1', label: 'A', lead: { avatar: 'slope-lilac', role: 'project-lead' }, status: 'active', requestCount: 0, uncertainCount: 0 }], inspectedKey: 'project-1', subjectKey: null, overflowCards: 0 };
  const d = descriptor(1, { kind: 'portfolio', cue: 'transition', portfolio: portfolio as NonNullable<CompanionSceneDescriptor['portfolio']> });
  expect(readCompanionSceneDescriptor(d).portfolio?.projects[0]?.lead.avatar).toBe('slope-lilac');
  for (const notice of ['permission','question','mixed','inspect','unknown']) expect(readCompanionSceneDescriptor({ ...d, portfolio: { ...portfolio, projects: [{ ...portfolio.projects[0], notice }] } }).portfolio?.projects[0]?.notice).toBe(notice);
  expect(() => readCompanionSceneDescriptor({ ...d, portfolio: { ...portfolio, projects: [{ ...portfolio.projects[0], notice: 'approved' }] } })).toThrow();
  expect(readCompanionSceneDescriptor({ ...d, portfolio: { ...portfolio, projects: [{ ...portfolio.projects[0], caption: '材料 <检查>' }] } }).portfolio?.projects[0]?.caption).toBe('材料 <检查>');
  expect(() => readCompanionSceneDescriptor({ ...d, portfolio: { ...portfolio, projects: [{ ...portfolio.projects[0], caption: 'x'.repeat(25) }] } })).toThrow();
  expect(() => readCompanionSceneDescriptor({ ...d, portfolio: { ...portfolio, projects: [{ ...portfolio.projects[0], caption: 'a\u202eb' }] } })).toThrow();
  expect(() => readCompanionSceneDescriptor({ ...d, portfolio: { ...portfolio, teams: [{ projectKey: 'absent', members: [], overflowCount: 0 }] } })).toThrow();
  expect(() => readCompanionSceneDescriptor({ ...d, portfolio: { ...portfolio, projects: [...portfolio.projects, ...portfolio.projects] } })).toThrow();
  expect(() => readCompanionSceneDescriptor({ ...d, portfolio: { ...portfolio, inspectedKey: 'absent' } })).toThrow();
  expect(() => readCompanionSceneDescriptor({ ...d, outcome: 'allowed', phase: 'resolve' })).toThrow();
  const second = { ...portfolio.projects[0], key: 'project-2', label: 'B' };
  const teams = [
    { projectKey: 'project-1', members: [{ key: 'a-child', avatar: 'slope-lilac', state: 'running' }], overflowCount: 0 },
    { projectKey: 'project-2', members: [{ key: 'b-child', avatar: 'pebble-blue', state: 'waiting' }], overflowCount: 2 },
  ];
  const two = { ...d, portfolio: { ...portfolio, projects: [...portfolio.projects, second], teams } };
  expect(readCompanionSceneDescriptor(two).portfolio?.teams).toEqual(teams);
  expect(() => readCompanionSceneDescriptor({ ...two, portfolio: { ...two.portfolio, teams: [teams[0], teams[0]] } })).toThrow();
  expect(() => readCompanionSceneDescriptor({ ...two, portfolio: { ...two.portfolio, teams: [teams[0], teams[1], teams[0], teams[1]] } })).toThrow();
  expect(() => readCompanionSceneDescriptor({ ...d, portfolio: { ...portfolio, team: teams[0] } })).toThrow();

});

it('resolves a single native inspection side and clears its receipt while dragging', () => {
  const f = fixture();
  const p = { mode: 'overview', projects: [], inspectedKey: null, subjectKey: null, overflowCards: 0 } as const;
  f.manager.update(f.owner, descriptor(4, { kind: 'portfolio', cue: 'transition', portfolio: { ...p, projects: [] } }), viewport);
  expect(f.manager.inspectionReceipt(f.owner.id)).toEqual({ scope: 'host/thread/branch', revision: 4, inspectionSide: 'right' });
  // 60 DIP fits the old brief card but not the complete 81 DIP team lane.
  f.owner.bounds.x = 860;
  expect(f.manager.inspectionReceipt(f.owner.id)?.inspectionSide).toBe('left');
  f.owner.bounds.x = 900;
  expect(f.manager.inspectionReceipt(f.owner.id)?.inspectionSide).toBe('left');
  f.manager.block(f.owner.id, true);
  expect(f.manager.inspectionReceipt(f.owner.id)?.inspectionSide).toBeNull();
});

it('admits only bounded drawing identities, not renderer URLs or crop data', () => {
 const drawing={bundle:'selected' as const,epoch:'a'.repeat(64),packageId:'v3-director-supervise',frameIndex:0};
 expect(readCompanionSceneDescriptor(descriptor(1,{drawing,layout:'spatial-b-v1'})).drawing).toEqual(drawing);
 for(const change of [{bundle:'https://example.test'},{epoch:'old'},{frameIndex:-1},{packageId:''}]) expect(()=>readCompanionSceneDescriptor(descriptor(1,{drawing:{...drawing,...change} as typeof drawing}))).toThrow();
 const clean=readCompanionSceneDescriptor({...descriptor(1,{drawing}),drawing:{...drawing,url:'https://example.test/p.png',rect:[0,0,1,1]}});
 expect(clean.drawing).toEqual(drawing);
});
it('keeps B geometry in the same canvas basis and compresses before the real interactive footer', () => {
 const owner={x:100,y:80,width:360,height:480};
 const full=companionSceneLayout(owner,viewport,area,true), clipped=companionSceneLayout(owner,{...viewport,decorationBottom:360},area,true);
 expect(full.bounds.height).toBe(540); expect(full.layout.spatial?.id).toBe('spatial-b-v1');
 expect(full.layout.spatial?.bounds.bottom).toBeLessThanOrEqual(285);
 expect(clipped.layout.spatial?.bounds.bottom).toBeLessThanOrEqual(225);
 expect(clipped.layout.character.x).toBe(full.layout.character.x);
 expect(clipped.layout.spatial?.seats.map(s=>s.label)).toEqual(['A','B','C']);
 expect(()=>companionSceneLayout(owner,{...viewport,decorationBottom:481},area,true)).toThrow('floor');
});
it('honors the actual B report side, with neutral unavailable-side behavior rather than mirrored art', () => {
 const owner={x:200,y:100,width:360,height:480};
 expect(companionSceneLayout(owner,viewport,area,true,'left').layout.inspectionSide).toBe('left');
 expect(companionSceneLayout({...owner,x:0},viewport,area,true,'left').layout.inspectionSide).toBeNull();
 expect(companionSceneLayout({...owner,x:920},viewport,area,true,'right').layout.inspectionSide).toBeNull();
});
