import { expect, it } from 'vitest';
import { CompanionWindowMovement, requireCompanionWindow, applyCompanionPassthrough, type CompanionWindowOwner } from './companion-window';

it('keeps pointer-origin displacement, clamps to work area, and ignores late moves after cancel', () => {
  const positions: number[][] = [];
  const owner: CompanionWindowOwner = { id: 7, isDestroyed: () => false, getBounds: () => ({ x: 100, y: 100, width: 200, height: 200 }),
    setPosition: (x,y) => positions.push([x,y]), setIgnoreMouseEvents: () => {} };
  const movement = new CompanionWindowMovement(() => ({ x: -500, y: 0, width: 1000, height: 800 }));
  movement.drag(owner, { phase: 'move', screenX: 200, screenY: 200 }); expect(positions).toHaveLength(0);
  movement.drag(owner, { phase: 'start', screenX: 150, screenY: 150 });
  movement.drag(owner, { phase: 'move', screenX: 200, screenY: 220 }); expect(positions.at(-1)).toEqual([150,170]);
  movement.drag(owner, { phase: 'move', screenX: 10000, screenY: -500 }); expect(positions.at(-1)).toEqual([300,0]);
  movement.drag(owner, { phase: 'end' }); movement.drag(owner, { phase: 'move', screenX: 0, screenY: 0 }); expect(positions).toHaveLength(2);
  expect(movement.isDragging(owner.id)).toBe(false);
});
it('separates sender lifetimes and rejects non-finite coordinates', () => {
  const owner: CompanionWindowOwner = { id: 9, isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
    setPosition: () => {}, setIgnoreMouseEvents: () => {} };
  const movement = new CompanionWindowMovement(() => ({ x: 0, y: 0, width: 1000, height: 800 }));
  expect(() => movement.drag(owner, { phase: 'start', screenX: Infinity, screenY: 0 })).toThrow(/coordinates/);
  movement.drag(owner, { phase: 'start', screenX: 0, screenY: 0 }); movement.forget(8); expect(movement.isDragging(9)).toBe(true);
  movement.forget(9); expect(movement.isDragging(9)).toBe(false);
  expect(() => movement.drag({ ...owner, isDestroyed: () => true }, { phase: 'start', screenX: 0, screenY: 0 })).toThrow(/closed/);
});

it('rejects main-window senders and preserves Linux interaction or captured dragging', () => {
  const calls: boolean[] = [];
  const owner = { id: 3, __varinLabel: 'main', isDestroyed: () => false, getBounds: () => ({x:0,y:0,width:100,height:100}), setPosition: () => {}, setIgnoreMouseEvents: (value: boolean) => calls.push(value) };
  expect(() => requireCompanionWindow(owner)).toThrow(/sender/); expect(calls).toEqual([]);
  owner.__varinLabel = 'companion'; expect(requireCompanionWindow(owner)).toBe(owner);
  expect(applyCompanionPassthrough(owner, true, 'linux', false)).toEqual({ supported:false, enabled:false });
  expect(applyCompanionPassthrough(owner, true, 'win32', true).enabled).toBe(false);
  expect(applyCompanionPassthrough(owner, true, 'darwin', false).enabled).toBe(true);
  expect(() => applyCompanionPassthrough(owner, 'true', 'darwin', false)).toThrow(/boolean/);
});

import { companionWorldRect } from './companion-window';
it('anchors the world prop in sender content DIP space without assuming CSS pixels are physical pixels', () => {
  expect(companionWorldRect({ x: 900, y: 100, width: 400, height: 500 }, { x: 20, y: 10, width: 160, height: 160, viewportWidth: 200, viewportHeight: 250 }))
    .toEqual({ x: 940, y: 120, width: 320, height: 320 });
  expect(() => companionWorldRect({ x: 0, y: 0, width: 400, height: 500 }, { x: 180, y: 0, width: 160, height: 160, viewportWidth: 200, viewportHeight: 250 })).toThrow();
});
