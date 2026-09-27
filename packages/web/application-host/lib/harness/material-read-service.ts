import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DocumentReadRequest, FetchResult } from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { resolveResearchCaller } from "./research-access.js";

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
      if (!host.documentReader || !ctx.workspaceId) {
        return { status: "failed", url: "", reason: "Document reading is unavailable for this session" };
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
      const binding = await host.threadRegistry?.getSessionBinding(ctx.sessionId);
      const workspaceId = binding?.owningScopeId ?? ctx.workspaceId;
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
        if (snapshotId) return await host.documentReader.read(request, readContext);
        if (artifact) {
          if (!host.experimentService || !host.threadRegistry) return { status: "failed", url: "", reason: "Experiment artifacts are unavailable" };
          if (ctx.requestSource !== "user" && (!ctx.actor.grantedCapabilities.includes("read.experiment")
            || (ctx.actor.allowedMethods !== undefined && !ctx.actor.allowedMethods.includes("experiment.artifact")))) {
            return { status: "failed", url: "", reason: "Experiment reading is not granted to this agent" };
          }
          const caller = await resolveResearchCaller(host.threadRegistry, {
            sessionId: ctx.sessionId, workspaceId, executionWorkspaceId: ctx.workspaceId,
            ...(ctx.workspaceScope ? { workspaceScope: ctx.workspaceScope } : {}),
            ...(ctx.requestSource === "user" ? { user: true } : {}),
          });
          const original = await host.experimentService.readArtifact(caller, artifact.attemptId, artifact.artifactId, ctx.signal);
          const chunks: Buffer[] = [];
          for await (const chunk of original.chunks) { ctx.signal.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
          const source = Buffer.concat(chunks);
          if (!source.subarray(0, 1024).includes(Buffer.from("%PDF-"))) return { status: "failed", url: "", reason: "The selected artifact is not a PDF" };
          const { artifact: _artifact, ...readRequest } = request;
          return await host.documentReader.ingest({ source, sourceUrl: `experiment://${encodeURIComponent(artifact.attemptId)}/${encodeURIComponent(artifact.artifactId)}`,
            title: original.name, contentType: "application/pdf" }, readContext, { ...readRequest, view: request.view ?? "overview" });
        }
        const authorized = ctx.authorizedPaths[0];
        if (!host.readMaterialFile || !authorized || ctx.authorizedPaths.length !== 1
          || authorized.workspaceId !== ctx.workspaceId || authorized.inputPath !== request.path) {
          return { status: "failed", url: "", reason: "Document path has not been authorized for this session" };
        }
        const source = await host.readMaterialFile(ctx, authorized);
        ctx.signal.throwIfAborted();
        if (!source.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
          return { status: "failed", url: "", reason: "The selected material is not a PDF" };
        }
        const { path: _path, ...readRequest } = request;
        return await host.documentReader.ingest({
          source,
          sourceUrl: pathToFileURL(authorized.canonicalResourceId).href,
          title: path.basename(authorized.resourceId),
          contentType: "application/pdf",
        }, readContext, { ...readRequest, view: request.view ?? "overview" });
      } catch (error) {
        ctx.signal.throwIfAborted();
        return { status: "failed", url: "", reason: error instanceof Error ? error.message : "Document reading failed" };
      }
    },
  };
}
