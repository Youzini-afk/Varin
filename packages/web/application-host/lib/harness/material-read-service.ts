import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DocumentReadRequest, FetchResult } from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { resolveResearchCaller } from "./research-access.js";
import { sessionScopeId } from "./owner-scope.js";
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

/** Source owners admit bytes; this shared core only selects, identifies and ingests them.
 * Do not race source/iterator settlement against cancellation or turn an unknown owner
 * failure into a stopped-reader receipt. Runtime adapters retain that distinction. */
export async function readDocumentMaterial(reader: DocumentReader, request: DocumentReadRequest,
  context: DocumentReaderContext, sources: DocumentMaterialSources = {}): Promise<FetchResult> {
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
  if (snapshotId) return reader.read(request, context);
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
    return { status: "failed", url: input.sourceUrl, reason: artifact ? "The selected artifact is not a PDF" : "The selected material is not a PDF" };
  }
  const { path: _path, artifact: _artifact, ...readRequest } = request;
  return reader.ingest(input, context, { ...readRequest, view: request.view ?? "overview" });
}

type MaterialReadHost = Pick<HarnessServiceHost,
  "documentReader" | "readMaterialFile" | "documentReadingSettings" | "materialWebPolicy" | "threadRegistry" | "getWebBinding" | "experimentService"
>;

/** The router/HTTP adapter authorizes local paths before bytes enter the material store. */
export function createMaterialReadService(host: MaterialReadHost): HarnessService<"materials.read"> {
  return {
    handle: async (request: DocumentReadRequest, ctx: HarnessServiceContext): Promise<FetchResult> => {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        return { status: "failed", url: "", reason: "A document read request is required" };
      }
      if (!host.documentReader) {
        return { status: "failed", url: "", reason: "Document reading is unavailable for this session" };
      }
      const snapshotId = typeof request.snapshotId === "string" ? request.snapshotId.trim() : "";
      const binding = await host.threadRegistry?.getSessionBinding(ctx.sessionId);
      const workspaceId = binding?.owningScopeId ?? ctx.workspaceId ?? sessionScopeId(ctx.sessionId);
      const webBinding = host.getWebBinding(ctx.sessionId);
      const domains = webBinding ? webBinding.settings?.domains
        : snapshotId ? await host.materialWebPolicy?.(ctx.sessionId) : undefined;
      const engineOptions = request.parser === "docling" || request.ocr === true || request.view === "structure"
        ? await host.documentReadingSettings?.(ctx.sessionId) : undefined;
      const readContext = {
        workspaceId,
        authority: {
          owningWorkspaceId: workspaceId,
          sessionId: ctx.sessionId,
          ...(binding ? { threadId: binding.threadId, runId: binding.runId } : {}),
        },
        signal: ctx.signal,
        domainPolicy: {
          ...(domains?.allow === undefined ? {} : { allow: [...domains.allow] }),
          block: [...(domains?.block ?? [])],
        },
        ...(engineOptions ? { engineOptions } : {}),
      };
      try {
        return await readDocumentMaterial(host.documentReader, request, readContext, { readArtifact: async artifact => {
          if (!host.experimentService || !host.threadRegistry) throw new Error("Experiment artifacts are unavailable");
          if (ctx.requestSource !== "user" && (!ctx.actor.grantedCapabilities.includes("read.experiment")
            || (ctx.actor.allowedMethods !== undefined && !ctx.actor.allowedMethods.includes("experiment.artifact")))) {
            throw new Error("Experiment reading is not granted to this agent");
          }
          const caller = await resolveResearchCaller(host.threadRegistry, {
            sessionId: ctx.sessionId, workspaceId, executionWorkspaceId: ctx.workspaceId ?? workspaceId,
            ...(ctx.workspaceScope ? { workspaceScope: ctx.workspaceScope } : {}),
            ...(ctx.requestSource === "user" ? { user: true } : {}),
          });
          return host.experimentService.readArtifact(caller, artifact.attemptId, artifact.artifactId, ctx.signal);
        }, readPath: async inputPath => {
          const authorized = ctx.authorizedPaths[0];
          if (!host.readMaterialFile || !authorized || ctx.authorizedPaths.length !== 1
            || authorized.inputPath !== inputPath) {
            throw new Error("Document path has not been authorized for this session");
          }
          const source = await host.readMaterialFile(ctx, authorized);
          return {
            source,
            sourceUrl: pathToFileURL(authorized.canonicalResourceId).href,
            title: path.basename(authorized.resourceId),
            contentType: "application/pdf",
          };
        } });
      } catch (error) {
        ctx.signal.throwIfAborted();
        return { status: "failed", url: "", reason: error instanceof Error ? error.message : "Document reading failed" };
      }
    },
  };
}
