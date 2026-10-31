import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { CompanionWindowMovement, CompanionWindowPresentation, requireCompanionWindow, applyCompanionPassthrough, type CompanionWindowOwner } from './companion-window.js';

function presentationOwner() {
  const events = new EventEmitter();
  let destroyed = false;
  return Object.assign(events, {
    id: 1, webContents: new EventEmitter(), isDestroyed: () => destroyed,
    showInactive: vi.fn(), destroy: vi.fn(() => { destroyed = true; events.emit('closed'); }),
  });
}

it('keeps wake pending and the window hidden until the character has painted', async () => {
  const owner = presentationOwner(), presentation = new CompanionWindowPresentation();
  const ready = vi.fn();
  const wake = presentation.wait(owner).then(ready);
  owner.emit('ready-to-show');
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled(); expect(owner.showInactive).not.toHaveBeenCalled();
  presentation.presented(owner);
  await wake;
  expect(ready).toHaveBeenCalledOnce(); expect(owner.showInactive).toHaveBeenCalledOnce();
  presentation.presented(owner);
  expect(owner.showInactive).toHaveBeenCalledOnce();
  owner.destroy();
});

it('returns artwork failure to the wake caller and removes the incomplete window', async () => {
  const owner = presentationOwner(), presentation = new CompanionWindowPresentation();
  const wake = presentation.wait(owner);
  const failed = expect(wake).rejects.toThrow('Failed to fetch');
  presentation.fail(owner, 'Failed to fetch');
  await failed;
  presentation.presented(owner);
  expect(owner.destroy).toHaveBeenCalledOnce(); expect(owner.showInactive).not.toHaveBeenCalled();
});

it('keeps pointer-origin displacement, clamps to work area, and ignores late moves after cancel', () => {
  const positions: number[][] = [];
  const owner: CompanionWindowOwner = { id: 7, isDestroyed: () => false, getBounds: () => ({ x: 100, y: 100, width: 200, height: 200 }),
    getContentBounds() { return this.getBounds(); }, setPosition: (x,y) => positions.push([x,y]), setIgnoreMouseEvents: () => {} };
  const movement = new CompanionWindowMovement(() => ({ x: -500, y: 0, width: 1000, height: 800 }));
  movement.drag(owner, { phase: 'move', screenX: 200, screenY: 200 }); expect(positions).toHaveLength(0);
  // Down was CSS (25,25) in a 100px viewport: native content is 200 DIP.
  // IPC starts after the cursor already moved 25 DIP; this must not lose that motion.
  movement.drag(owner, { phase: 'start', screenX: 175, screenY: 175, anchor: {x:0.25,y:0.25} });
  movement.drag(owner, { phase: 'move', screenX: 200, screenY: 220 }); expect(positions.at(-1)).toEqual([150,170]);
  movement.drag(owner, { phase: 'move', screenX: 10000, screenY: -500 }); expect(positions.at(-1)).toEqual([300,0]);
  movement.drag(owner, { phase: 'end' }); movement.drag(owner, { phase: 'move', screenX: 0, screenY: 0 }); expect(positions).toHaveLength(2);
  expect(movement.isDragging(owner.id)).toBe(false);
});
it('separates sender lifetimes and rejects non-finite coordinates', () => {
  const owner: CompanionWindowOwner = { id: 9, isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
    getContentBounds() { return this.getBounds(); }, setPosition: () => {}, setIgnoreMouseEvents: () => {} };
  const movement = new CompanionWindowMovement(() => ({ x: 0, y: 0, width: 1000, height: 800 }));
  expect(() => movement.drag(owner, { phase: 'start', screenX: Infinity, screenY: 0 })).toThrow(/coordinates/);
  expect(() => movement.drag(owner, { phase: 'start', screenX: 0, screenY: 0, anchor: {x:NaN,y:0} })).toThrow(/anchor/);
  movement.drag(owner, { phase: 'start', screenX: 0, screenY: 0, anchor: {x:0,y:0} }); movement.forget(8); expect(movement.isDragging(9)).toBe(true);
  movement.forget(9); expect(movement.isDragging(9)).toBe(false);
  expect(() => movement.drag({ ...owner, isDestroyed: () => true }, { phase: 'start', screenX: 0, screenY: 0 })).toThrow(/closed/);
});

it('rejects main-window senders and preserves Linux interaction or captured dragging', () => {
  const calls: boolean[] = [];
  const owner = { id: 3, __varinLabel: 'main', isDestroyed: () => false, getBounds: () => ({x:0,y:0,width:100,height:100}), getContentBounds() { return this.getBounds(); }, setPosition: () => {}, setIgnoreMouseEvents: (value: boolean) => calls.push(value) };
  expect(() => requireCompanionWindow(owner)).toThrow(/sender/); expect(calls).toEqual([]);
  owner.__varinLabel = 'companion'; expect(requireCompanionWindow(owner)).toBe(owner);
  expect(applyCompanionPassthrough(owner, true, 'linux', false)).toEqual({ supported:false, enabled:false });
  expect(applyCompanionPassthrough(owner, true, 'win32', true).enabled).toBe(false);
  expect(applyCompanionPassthrough(owner, true, 'darwin', false).enabled).toBe(true);
  expect(() => applyCompanionPassthrough(owner, 'true', 'darwin', false)).toThrow(/boolean/);
});

import { companionWorldRect } from './companion-window.js';
it('anchors the world prop in sender content DIP space without assuming CSS pixels are physical pixels', () => {
  expect(companionWorldRect({ x: 900, y: 100, width: 400, height: 500 }, { x: 20, y: 10, width: 160, height: 160, viewportWidth: 200, viewportHeight: 250 }))
    .toEqual({ x: 940, y: 120, width: 320, height: 320 });
  expect(() => companionWorldRect({ x: 0, y: 0, width: 400, height: 500 }, { x: 180, y: 0, width: 160, height: 160, viewportWidth: 200, viewportHeight: 250 })).toThrow();
});

import { captureCompanionPlacement, restoreCompanionPlacement } from './companion-window.js';
it('restores independent companion display offsets and clamps after display removal or work-area changes', () => {
  const secondary = { id: 2, workArea: { x: 1400, y: 40, width: 1200, height: 900 } };
  const original = { x: 2100, y: 300, width: 360, height: 480 };
  const saved = captureCompanionPlacement(original, secondary);
  expect(restoreCompanionPlacement(saved, original, [secondary], 2)).toEqual(original);
  const rotated = { id: 2, workArea: { x: -900, y: 30, width: 800, height: 1200 } };
  expect(restoreCompanionPlacement(saved, original, [rotated], 2)).toEqual({x:-460,y:290,width:360,height:480});
  const primary = { id: 1, workArea: { x: 0, y: 0, width: 1000, height: 700 } };
  expect(restoreCompanionPlacement(saved, original, [primary], 1)).toEqual({x:640,y:220,width:360,height:480});
  expect(restoreCompanionPlacement({...saved,offsetX:NaN}, original, [primary], 1)).toBeNull();
});
