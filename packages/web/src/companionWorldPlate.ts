/** Decorative native surfaces use installed local art, without application APIs. */
export function readCompanionWorldPlate(value: unknown): { file: string; sha256: string } {
  const record = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item);
  if (!record(value)) throw new Error('Invalid companion world-plate epoch');
  const plate = value.worldStool;
  // Both authored geometries have a fixed, separately rendered world stool.
  // Do not admit arbitrary future epochs just because their package labels agree.
  if (!['varin-upright-v2', 'varin-canonical-v5-study'].includes(value.geometryEpoch as string)
    || !record(plate) || typeof plate.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(plate.sha256)
    || plate.file !== `world-stool-${plate.sha256.slice(0, 16)}.png`
    || !Array.isArray(value.packages) || value.packages.length === 0
    || !value.packages.every(item => record(item) && item.geometryReference === value.geometryEpoch)) {
    throw new Error('Invalid companion world-plate epoch');
  }
  return { file: plate.file as string, sha256: plate.sha256 };
}

export async function verifyCompanionWorldPlate(bytes: ArrayBuffer, sha256: string): Promise<void> {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== sha256) throw new Error('Companion world-plate hash mismatch');
}
