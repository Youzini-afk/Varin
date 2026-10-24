import type { DocumentReadRequest, FetchResult } from "@varin/protocol";
import type { DocumentIngestInput, DocumentReader, DocumentReaderContext } from "./document-reading.js";

export interface DocumentArtifactSource {
  name: string;
  byteLength?: number;
  chunks: AsyncIterable<Uint8Array>;
}
export interface DocumentMaterialSources {
  readPath?(path: string, signal?: AbortSignal): Promise<DocumentIngestInput>;
  readArtifact?(artifact: NonNullable<DocumentReadRequest["artifact"]>, signal?: AbortSignal): Promise<DocumentArtifactSource>;
}
export type AlternateDocumentReader = (request: DocumentReadRequest, context: DocumentReaderContext, source?: DocumentIngestInput) => Promise<FetchResult | undefined>;

/** Source owners admit bytes; this shared core only selects, identifies and ingests them.
 * Do not race source/iterator settlement against cancellation or turn an unknown owner
 * failure into a stopped-reader receipt. Runtime adapters retain that distinction. */
export async function readDocumentMaterial(reader: DocumentReader, request: DocumentReadRequest,
  context: DocumentReaderContext, sources: DocumentMaterialSources = {}, alternate?: AlternateDocumentReader): Promise<FetchResult> {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return { status: "failed", url: "", reason: "A document read request is required" };
  }
  const localPath = typeof request.path === "string" ? request.path.trim() : "";
  const snapshotId = typeof request.snapshotId === "string" ? request.snapshotId.trim() : "";
  const artifact = request.artifact;
  if ([Boolean(localPath), Boolean(snapshotId), artifact !== undefined].filter(Boolean).length !== 1) {
    return { status: "failed", url: "", reason: "Provide exactly one path, snapshotId or experiment artifact" };
  }
  if (artifact !== undefined && (!artifact || typeof artifact !== "object" || typeof artifact.attemptId !== "string"
    || !artifact.attemptId.trim() || typeof artifact.artifactId !== "string" || !artifact.artifactId.trim())) {
    return { status: "failed", url: "", reason: "A valid experiment attempt and artifact are required" };
  }
  context.signal?.throwIfAborted();
  request = { ...request, view: request.view ?? (request.office?.view === 'overview' ? 'overview' : 'text') };
  if (snapshotId) return await alternate?.(request, context) ?? reader.read(request, context);
  let input: DocumentIngestInput;
  if (artifact) {
    if (!sources.readArtifact) return { status: "failed", url: "", reason: "Experiment artifacts are unavailable" };
    const original = await sources.readArtifact(artifact, context.signal);
    const chunks: Buffer[] = [];
    for await (const chunk of original.chunks) {
      context.signal?.throwIfAborted();
      chunks.push(Buffer.from(chunk));
    }
    input = { source: Buffer.concat(chunks), sourceUrl: `experiment://${encodeURIComponent(artifact.attemptId)}/${encodeURIComponent(artifact.artifactId)}`,
      title: original.name, contentType: "application/pdf" };
  } else {
    if (!sources.readPath) return { status: "failed", url: "", reason: "Document paths are unavailable" };
    input = await sources.readPath(request.path!, context.signal);
  }
  context.signal?.throwIfAborted();
  if (!input.source.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    return await alternate?.(request, context, input)
      ?? { status: "failed", url: input.sourceUrl, reason: "This document format is unsupported by the available readers" };
  }
  const { path: _path, artifact: _artifact, ...readRequest } = request;
  return reader.ingest(input, context, readRequest);
}
