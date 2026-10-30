import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CompanionPlayback, frameAt, route, type PlaybackAsset } from './playback.mjs';
import { readCompanionPackage } from './sequencePackage';

// The installed formal bundle, admitted exactly like the normal companion window does.
const raw = JSON.parse(readFileSync(new URL('../../../../web/public/companion-assets/bundle.json', import.meta.url), 'utf8')) as { packages: unknown[] };
const assets = raw.packages.map(value => readCompanionPackage(value, false)).filter((item): item is PlaybackAsset =>
  item.reviewStatus === 'accepted' && item.stage === 'motion-candidate' && !!item.geometryReference && !!item.entryPose && !!item.exitPose);
const byAction = (action: string) => assets.find(item => item.action === action);
const settle = (player: CompanionPlayback, ms = 6000) => { for (let t = 0; t < ms; t += 50) player.tick(50); };

it('the formal bundle reaches work-active from its resting and supervising entries and returns', () => {
  const work = byAction('work-active');
  expect(work?.id).toBe('v5-work-active');
  for (const entry of ['idle-closed', 'director-supervise', 'welcome']) {
    const from = byAction(entry)!;
    expect(route(from, work, assets).status, entry).toBe('ready');
    expect(route(work!, from, assets).status, `back to ${entry}`).toBe('ready');
  }
});

it('a permission or question interrupts work-active through authored routes', () => {
  for (const notice of ['permission', 'query', 'director-notify-attention']) {
    const player = new CompanionPlayback(assets);
    player.request(byAction('work-active')!.id); settle(player);
    expect(player.current?.action).toBe('work-active');
    expect(player.request(byAction(notice)!.id, { urgent: true }).status, notice).toBe('ready');
    settle(player);
    expect(player.current?.action, notice).toBe(notice);
    expect(player.blocker).toBeNull();
    // Once the request is resolved, work resumes along the same route graph.
    expect(player.request(byAction('work-active')!.id).status).toBe('ready');
    settle(player);
    expect(player.current?.action).toBe('work-active');
  }
});

it('work-active survives a pickup and landing and continues afterwards', () => {
  const player = new CompanionPlayback(assets);
  player.request(byAction('work-active')!.id); settle(player, 1500);
  const shown = player.current!;
  const exposure = shown.frames.indexOf(frameAt(shown, player.timeMs)!);
  expect(player.grab({ packageId: shown.id, exposure })).toBe(true);
  expect(player.gesture).not.toBeNull();
  settle(player, 2000);
  player.release({ packageId: player.current!.id, exposure: 0 });
  settle(player);
  expect(player.gesture).toBeNull();
  expect(player.blocker).toBeNull();
  expect(player.request(byAction('work-active')!.id).status).toBe('ready');
  settle(player);
  expect(player.current?.action).toBe('work-active');
});
