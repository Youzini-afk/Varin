/** Visual design-space data, independent of native window/persisted character coordinates.
 * Current interface review uses the existing seated canvas. Replace this data with
 * the accepted upright scene composition; never deform character art to fit it.
 */
export const COMPANION_SCENE_GEOMETRY = {
  id: 'seated-interface-layout-v1',
  character: { x: 50, y: 25, width: 200, height: 200 },
  protectedFace: { x: 82, y: 18, width: 134, height: 90 },
  artworkExtent: { left: 9, right: 285 },
} as const;
