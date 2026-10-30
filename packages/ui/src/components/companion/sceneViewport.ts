export interface SceneViewport { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number }
/** Keep native geometry strict. A scrolled/hidden character suppresses its last
 * legal surface; only a fully visible current rectangle can relocate/show it. */
export function visibleSceneViewport(rect: Pick<DOMRect, 'x' | 'y' | 'width' | 'height'> | undefined,
  width: number, height: number, previous: SceneViewport | null): { viewport: SceneViewport | null; visible: boolean } {
  const valid = rect && [rect.x,rect.y,rect.width,rect.height,width,height].every(Number.isFinite)
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && width > 0 && height > 0
    && rect.x + rect.width <= width && rect.y + rect.height <= height;
  return valid ? { viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: width, viewportHeight: height }, visible: true }
    : { viewport: previous, visible: false };
}
