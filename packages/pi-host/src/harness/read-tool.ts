import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ReadOperations,
  type ReadToolOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type { HostServicesBridge } from "./host-services-bridge.js";

const startsWith = (bytes: Buffer, prefix: readonly number[]): boolean => (
  bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte)
);

const asciiAt = (bytes: Buffer, offset: number, value: string): boolean => (
  bytes.length >= offset + value.length
  && [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
);

const uint32be = (bytes: Buffer, offset: number): number => (
  ((bytes[offset] ?? 0) * 0x1000000)
  + ((bytes[offset + 1] ?? 0) << 16)
  + ((bytes[offset + 2] ?? 0) << 8)
  + (bytes[offset + 3] ?? 0)
);

const uint32le = (bytes: Buffer, offset: number): number => (
  (bytes[offset] ?? 0)
  + ((bytes[offset + 1] ?? 0) << 8)
  + ((bytes[offset + 2] ?? 0) << 16)
  + ((bytes[offset + 3] ?? 0) * 0x1000000)
);

/** Match the formats handled by Pi's native read tool using the authorized bytes. */
const detectImageMimeType = (bytes: Buffer): string | null => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return bytes[3] === 0xf7 ? null : "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
  if (startsWith(bytes, png)) {
    if (bytes.length < 16 || uint32be(bytes, png.length) !== 13 || !asciiAt(bytes, 12, "IHDR")) return null;
    for (let offset: number = png.length; offset + 8 <= bytes.length;) {
      const chunkLength = uint32be(bytes, offset);
      if (asciiAt(bytes, offset + 4, "acTL")) return null;
      if (asciiAt(bytes, offset + 4, "IDAT")) return "image/png";
      const nextOffset = offset + 8 + chunkLength + 4;
      if (nextOffset <= offset || nextOffset > bytes.length) return null;
      offset = nextOffset;
    }
    return null;
  }
  if (asciiAt(bytes, 0, "GIF")) return "image/gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  if (asciiAt(bytes, 0, "BM") && bytes.length >= 30) {
    const supportedBitsPerPixel: readonly number[] = [1, 4, 8, 16, 24, 32];
    const declaredLength = uint32le(bytes, 2);
    const pixelOffset = uint32le(bytes, 10);
    const dibLength = uint32le(bytes, 14);
    const planesOffset = dibLength === 12 ? 22 : 26;
    const bitsOffset = dibLength === 12 ? 24 : 28;
    const planes = (bytes[planesOffset] ?? 0) + ((bytes[planesOffset + 1] ?? 0) << 8);
    const bits = (bytes[bitsOffset] ?? 0) + ((bytes[bitsOffset + 1] ?? 0) << 8);
    if ((declaredLength === 0 || declaredLength >= 26)
      && pixelOffset >= 14 + dibLength
      && (declaredLength === 0 || pixelOffset < declaredLength)
      && ((dibLength === 12 && bytes.length >= 26) || (dibLength >= 40 && dibLength <= 124))
      && planes === 1 && supportedBitsPerPixel.includes(bits)) return "image/bmp";
  }
  return null;
};

const bytesReadOperations = (bytes: Buffer): ReadOperations => ({
  access: async () => undefined,
  detectImageMimeType: async () => detectImageMimeType(bytes),
  readFile: async () => bytes,
});

/**
 * Keep Pi's read implementation and rendering intact while selecting the
 * bytes for a dirty editor document through the authenticated Host service.
 */
export function createSurfaceAwareReadTool(
  bridge: HostServicesBridge,
  cwd: string,
  options: Pick<ReadToolOptions, "autoResizeImages"> = {},
): ToolDefinition {
  const native = createReadToolDefinition(cwd, options);
  const wrapped: ReturnType<typeof createReadToolDefinition> = {
    ...native,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Pin one absolute path for Host authorization. The Host returns disk
      // bytes from the admitted canonical target so Pi never reopens the alias.
      const anchoredParams = params.path === undefined
        ? params
        : { ...params, path: path.resolve(cwd, params.path) };
      const source = await bridge.request(
        "document.readSource",
        { path: anchoredParams.path, page: { offset: params.offset ?? 1, limit: params.limit ?? DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES } },
        signal === undefined ? {} : { signal },
      );
      if (source.page) {
        const page = source.page;
        const details = { source: source.source,
          ...('revision' in source ? { revision: source.revision } : {}),
          ...(source.source === 'working-branch' ? { provenance: source.provenance } : {}),
          page: page.kind === 'image' ? { kind: 'image' } : page.kind === 'binary' ? page : {
            kind: page.kind, startLine: page.startLine, lineCount: page.lineCount, eof: page.eof,
            nextOffset: page.nextOffset, truncatedBy: page.truncatedBy,
          } };
        if (page.kind === 'binary') return {
          content: [{ type: 'text', text: `This is a ${page.format} binary file (${page.byteLength} bytes). Read cannot display it as source text; use a tool for this file format.` }],
          details,
        } as Awaited<ReturnType<typeof native.execute>>;
        if (page.kind === 'text') {
          let text = page.text;
          if (page.firstLineExceedsLimit) {
            text = `[Line ${page.startLine} exceeds the ${DEFAULT_MAX_BYTES / 1024}KB read output limit. Use a byte-oriented file tool to inspect this line.]`;
          } else if (!page.eof) {
            text += `\n\n[Showing lines ${page.startLine}-${page.startLine + page.lineCount - 1}. Use offset=${page.nextOffset} to continue.]`;
          }
          return { content: [{ type: 'text', text }], details } as Awaited<ReturnType<typeof native.execute>>;
        }
        const imageBytes = Buffer.from(page.base64, 'base64');
        if (!detectImageMimeType(imageBytes)) return { content: [{ type: 'text',
          text: 'This image format is not supported by read. Use an image tool for this file.' }], details } as Awaited<ReturnType<typeof native.execute>>;
        const image = createReadToolDefinition(cwd, { ...options, operations: bytesReadOperations(imageBytes) });
        const result = await image.execute(toolCallId, anchoredParams, signal, onUpdate, ctx);
        return { ...result, details: { ...result.details, ...details } } as Awaited<ReturnType<typeof native.execute>>;
      }
      if (source.source === "disk") {
        if (typeof source.base64 !== "string") {
          throw new Error("Document read source did not return authorized disk bytes");
        }
        const disk = createReadToolDefinition(cwd, {
          ...options,
          operations: bytesReadOperations(Buffer.from(source.base64, "base64")),
        });
        return disk.execute(toolCallId, anchoredParams, signal, onUpdate, ctx);
      }
      if (source.source === "working-branch") {
        if (source.missing || typeof source.base64 !== "string") {
          const missing = {
            content: [{
              type: "text" as const,
              text: source.missing
                ? `File not found in working branch (${source.provenance.origin})`
                : "Working branch content is unavailable",
            }],
            details: {
              revision: source.revision,
              source: source.source,
              provenance: source.provenance,
              ...(source.missing ? { missing: true } : {}),
            },
          };
          return missing as Awaited<ReturnType<typeof native.execute>>;
        }
        const bytes = Buffer.from(source.base64, "base64");
        const operations = bytesReadOperations(bytes);
        const branch = createReadToolDefinition(cwd, { ...options, operations });
        const result = await branch.execute(toolCallId, anchoredParams, signal, onUpdate, ctx);
        return {
          ...result,
          details: {
            ...(result.details ?? {}),
            revision: source.revision,
            source: source.source,
            provenance: source.provenance,
          },
        };
      }
      if (
        source.source !== "surface-draft"
        || typeof source.base64 !== "string"
        || typeof source.revision !== "string"
      ) {
        throw new Error("Document read source returned an invalid surface snapshot");
      }
      const bytes = Buffer.from(source.base64, "base64");
      const operations = bytesReadOperations(bytes);
      const surface = createReadToolDefinition(cwd, {
        ...options,
        operations,
      });
      const result = await surface.execute(toolCallId, anchoredParams, signal, onUpdate, ctx);
      return {
        ...result,
        details: {
          ...(result.details ?? {}),
          revision: source.revision,
          source: source.source,
        },
      };
    },
  };
  return wrapped as unknown as ToolDefinition;
}
