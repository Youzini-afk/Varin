import { expect, test } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderImagePreview } from './image-preview.js';

test('creates a bounded long-image derivative and leaves the original bytes intact', async () => {
  const canvas = createCanvas(800, 4000), context = canvas.getContext('2d');
  context.fillStyle = 'red'; context.fillRect(0, 0, 800, 1000);
  context.fillStyle = 'blue'; context.fillRect(0, 1000, 800, 3000);
  const original = await canvas.encode('png');
  const preview = await renderImagePreview(original, 'image/png');
  expect(preview).toMatchObject({ width: 800, height: 4000, mime: 'image/webp', cropped: true });
  const image = await loadImage(preview.bytes);
  expect([image.width, image.height]).toEqual([800, 960]);
  expect((await loadImage(original)).height).toBe(4000);
  const sampled = createCanvas(1, 1); sampled.getContext('2d').drawImage(image, 0, 0, 1, 1);
  const pixel = sampled.getContext('2d').getImageData(0, 0, 1, 1).data;
  expect(pixel[0]).toBeGreaterThan(240); expect(pixel[2]).toBeLessThan(15);
});

test('retains small images, transparent pixels, GIF frames and browser-sandboxed SVG', async () => {
  const canvas = createCanvas(40, 30), bytes = await canvas.encode('png');
  expect((await renderImagePreview(bytes, 'image/png')).bytes).toBe(bytes);
  const gif = await canvas.encode('gif');
  expect((await renderImagePreview(gif, 'image/gif')).bytes).toBe(gif);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"/>');
  expect(await renderImagePreview(svg, 'image/svg+xml')).toEqual({ bytes: svg, mime: 'image/svg+xml' });
});
