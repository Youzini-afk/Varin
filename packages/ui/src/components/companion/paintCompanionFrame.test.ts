import { expect, test, vi } from 'vitest';
import { paintCompanionFrame } from './paintCompanionFrame';
import type { CompanionPackage } from './sequencePackage';

const sequence = { canvas: [512, 512], pages: [{ file: 'atlas.png' }],
  frames: [{ page: 0, rect: [20, 30, 120, 200], offset: [100, 80] }] } as CompanionPackage;
const image = { width: 1024, height: 1024 } as ImageBitmap;
function surface() {
  let width = 512, height = 512, pixels = 'last-good';
  const resize = vi.fn();
  const context = { clearRect: vi.fn(() => { pixels = ''; }), drawImage: vi.fn(() => { pixels = 'new-exact-frame'; }),
    save: vi.fn(), restore: vi.fn(), isContextLost: vi.fn(() => false), globalCompositeOperation: 'source-over' };
  const canvas = { get width() { return width; }, set width(value) { width = value; pixels = ''; resize(); },
    get height() { return height; }, set height(value) { height = value; pixels = ''; resize(); }, getContext: () => context } as unknown as HTMLCanvasElement;
  return { canvas, context, resize, pixels: () => pixels };
}

test('closed/unready bitmap or staging failure preserves last successful visible pixels', () => {
  const target = surface(), scratch = surface();
  for (const images of [[], [{ width: 0, height: 0 } as ImageBitmap], [{ width: 40, height: 40 } as ImageBitmap]]) {
    expect(paintCompanionFrame(target.canvas, scratch.canvas, sequence, images, 0)).toBe(false);
    expect(target.pixels()).toBe('last-good');
  }
  expect(paintCompanionFrame(target.canvas, scratch.canvas, sequence, [image], 0)).toBe(true);
  const lastSuccessfulPixels = target.pixels();
  const successfulCopies = target.context.drawImage.mock.calls.length;
  scratch.context.drawImage.mockImplementationOnce(() => { throw new Error('Detached ImageBitmap'); });
  expect(paintCompanionFrame(target.canvas, scratch.canvas, sequence, [image], 0)).toBe(false);
  expect(target.pixels()).toBe(lastSuccessfulPixels);
  expect(target.resize).not.toHaveBeenCalled();
  expect(target.context.drawImage).toHaveBeenCalledTimes(successfulCopies);
  expect(paintCompanionFrame(target.canvas, scratch.canvas, sequence, [image], 0)).toBe(true);
  expect(target.context.drawImage).toHaveBeenCalledTimes(successfulCopies + 1);
});

test('exact source commits once with copy, without clearing or reallocating same-sized visible canvas', () => {
  const target = surface(), scratch = surface();
  expect(paintCompanionFrame(target.canvas, scratch.canvas, sequence, [image], 0)).toBe(true);
  expect(scratch.context.drawImage).toHaveBeenCalledWith(image, 20, 30, 120, 200, 100, 80, 120, 200);
  expect(target.context.drawImage).toHaveBeenCalledWith(scratch.canvas, 0, 0);
  expect(target.context.globalCompositeOperation).toBe('copy');
  expect(target.context.restore).toHaveBeenCalledOnce();
  expect(target.context.clearRect).not.toHaveBeenCalled();
  expect(target.resize).not.toHaveBeenCalled();
  expect(paintCompanionFrame(target.canvas, scratch.canvas, sequence, [image], 4)).toBe(false);
  expect(target.context.drawImage).toHaveBeenCalledTimes(1);
});

test('known lost drawing context cannot publish a successful new frame', () => {
  const target = surface(), scratch = surface();
  target.context.isContextLost.mockReturnValue(true);
  expect(paintCompanionFrame(target.canvas, scratch.canvas, sequence, [image], 0)).toBe(false);
  expect(target.context.drawImage).not.toHaveBeenCalled();
});
