/** Length-prefixed metadata and binary body, carried by the original HTTP stream. */
export const BINARY_EVENT_CONTENT_TYPE = 'application/vnd.varin.events';

export function encodeBinaryEvent(event: unknown, body: Uint8Array = new Uint8Array()): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify(event));
  const frame = new Uint8Array(8 + metadata.byteLength + body.byteLength);
  const header = new DataView(frame.buffer);
  header.setUint32(0, metadata.byteLength);
  header.setUint32(4, body.byteLength);
  frame.set(metadata, 8);
  frame.set(body, 8 + metadata.byteLength);
  return frame;
}

export async function* decodeBinaryEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<{ event: unknown; body: Uint8Array }> {
  let pending: Uint8Array = new Uint8Array();
  const read = async (length: number, allowEnd = false): Promise<Uint8Array | null> => {
    const parts: Uint8Array[] = [];
    let remaining = length;
    while (remaining > 0) {
      if (!pending.byteLength) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (allowEnd && remaining === length) return null;
          throw new Error('Binary event stream ended inside a frame');
        }
        pending = chunk.value;
      }
      const size = Math.min(remaining, pending.byteLength);
      parts.push(pending.subarray(0, size));
      pending = pending.subarray(size);
      remaining -= size;
    }
    if (parts.length === 1) return parts[0]!;
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
    return result;
  };
  for (;;) {
    const bytes = await read(8, true);
    if (!bytes) return;
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metadata = await read(header.getUint32(0));
    const body = await read(header.getUint32(4));
    yield { event: JSON.parse(new TextDecoder().decode(metadata!)), body: body! };
  }
}
