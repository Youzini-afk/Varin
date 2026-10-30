import type { CompanionPackage } from './sequencePackage';

/** Prepare the exact source offscreen before touching the visible backing store.
 * A decode/detached-bitmap failure leaves the last successful drawing authoritative.
 * One reusable canvas, not another animation owner or an interpolated pose. */
export function paintCompanionFrame(canvas: HTMLCanvasElement, scratch: HTMLCanvasElement,
  sequence: CompanionPackage, images: readonly ImageBitmap[], exposure: number): boolean {
  const frame = sequence.frames[exposure], image = frame && images[frame.page];
  const [width, height] = sequence.canvas;
  if (images.length !== sequence.pages.length || !frame || !image || !image.width || !image.height
    || frame.rect[0] + frame.rect[2] > image.width || frame.rect[1] + frame.rect[3] > image.height) return false;
  const stage = scratch.getContext('2d'), target = canvas.getContext('2d');
  if (!stage || !target || stage.isContextLost?.() || target.isContextLost?.()) return false;
  try {
    if (scratch.width !== width) scratch.width = width;
    if (scratch.height !== height) scratch.height = height;
    stage.clearRect(0, 0, width, height);
    stage.drawImage(image, ...frame.rect, ...frame.offset, frame.rect[2], frame.rect[3]);
    if (stage.isContextLost?.()) return false;
    // Normal exposures share 512px geometry: never reset the visible canvas per frame.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    target.save();
    try {
      target.globalCompositeOperation = 'copy';
      target.drawImage(scratch, 0, 0);
    } finally { target.restore(); }
    return !target.isContextLost?.();
  } catch {
    return false;
  }
}
