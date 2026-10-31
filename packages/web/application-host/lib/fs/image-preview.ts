/** Chat-sized derivatives only. Original files remain with the file owner. */
export async function renderImagePreview(bytes: Buffer, mime: string): Promise<{
  bytes: Buffer; mime: string; width?: number; height?: number; cropped?: boolean;
}> {
  // SVG stays in the browser's image sandbox. Animated formats keep their frames.
  if (mime === 'image/svg+xml') return { bytes, mime };
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(bytes);
  const { width, height } = image;
  const animated = hasAnimation(bytes, mime);
  if (animated || (width <= 1440 && height <= 960)) return { bytes, mime, width, height };
  // These are display targets (2x a normal chat column), not source-size limits.
  const cropped = height / width > 2.4;
  const sourceHeight = cropped ? Math.min(height, width * 1.2) : height;
  const scale = Math.min(1, 1440 / width, 960 / sourceHeight);
  const canvas = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(sourceHeight * scale)));
  canvas.getContext('2d').drawImage(image, 0, 0, width, sourceHeight, 0, 0, canvas.width, canvas.height);
  return { bytes: await canvas.encode('webp', 92), mime: 'image/webp', width, height, cropped };
}

function hasAnimation(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/gif') return true;
  // Walk container chunks: colour profiles/metadata may precede animation data.
  if (mime === 'image/webp') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
      if (kind === 'ANIM' || kind === 'ANMF') return true;
      offset += 8 + size + (size % 2);
    }
  } else if (mime === 'image/png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (kind === 'acTL') return true;
      offset += 12 + size;
    }
  } else if (mime === 'image/avif' && bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const end = Math.min(bytes.length, bytes.readUInt32BE(0));
    for (let offset = 8; offset + 4 <= end; offset += 4) if (bytes.toString('ascii', offset, offset + 4) === 'avis') return true;
  }
  return false;
}
