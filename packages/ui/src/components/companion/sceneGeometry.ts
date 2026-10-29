/** Visual design-space data, independent of native window/persisted character coordinates.
 * Upright shared anchors mapped into scene coordinates. Face guard includes the
 * authored side-yaw and forward-read envelope; never deform character art to fit it.
 */
export const COMPANION_SCENE_GEOMETRY = {
  id: 'upright-v2-scene-layout',
  character: { x: 50, y: 25, width: 200, height: 200 },
  protectedFace: { x: 82, y: 18, width: 134, height: 90 },
  computerLeft: { x: 104, y: 146 },
  computerRight: { x: 166, y: 147 },
  artworkExtent: { left: 9, right: 285 },
} as const;

/** Three readable identity seats at the native 360px character size; further
 * confirmed scoped members are represented by the factual overflow count. */
export { COMPANION_TEAM_VISIBLE_LIMIT } from '@varin/application-client/desktop';
