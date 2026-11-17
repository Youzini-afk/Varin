import path from "node:path";
import { randomUUID } from "node:crypto";
import type { KernelScopedClient } from "../kernel/kernel-client.js";

export type AcpFileRequest =
  | { action: "read"; path: string; line?: number; limit?: number }
  | { action: "write"; path: string; content: string };
export type AcpFileAccess = (
  input: AcpFileRequest,
  signal?: AbortSignal,
) => Promise<{ content?: string }>;
export interface AcpFileContext {
  client: KernelScopedClient;
  workspaceId: string;
  rootId: string;
  canonicalRoot: string;
}

/** ACP text operations use the existing native file owner and its version conflicts.
 * The context is supplied by the original conversation Source, never by the callback. */
export function createAcpFileAccess(
  resolve: () => Promise<AcpFileContext>,
): AcpFileAccess {
  const observed = new Map<string, string>();
  return async (input, signal) => {
    const context = await resolve();
    if (!input || typeof input.path !== "string" || !input.path.trim())
      throw new Error("ACP file path is required");
    const absolute = path.resolve(context.canonicalRoot, input.path);
    const relative = path.relative(context.canonicalRoot, absolute);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("File is outside this conversation’s execution Source");
    const address = {
      workspaceId: context.workspaceId,
      rootId: context.rootId,
      path: relative.replaceAll("\\", "/"),
    };
    const capture = async (version?: string) => {
      const result = await context.client.fileCapture(
        {
          ...address,
          operationId: `acp-capture:${randomUUID()}`,
          store: false,
          ...(version ? { expectedReadVersion: version } : {}),
        },
        signal,
      );
      if (typeof result.stateJson !== "string")
        throw new Error("File state is unavailable");
      return result.stateJson;
    };
    if (input.action === "read") {
      for (const value of [input.line, input.limit])
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
          throw new Error("ACP line and limit must be positive integers");
      let content = "",
        offset = 0,
        version: string | undefined;
      for (;;) {
        const result = await context.client.fileRead(
          { ...address, offset, encoding: "utf-8" },
          signal,
        );
        if (result.missing) throw new Error("File does not exist");
        if (typeof result.content?.text !== "string")
          throw new Error("File is not UTF-8 text");
        if (offset && version !== result.readVersion)
          throw new Error("File changed while reading; read it again");
        version = result.readVersion;
        content += result.content.text;
        if (result.content.eof) break;
        if (result.content.nextOffset <= offset)
          throw new Error("File reader made no progress");
        offset = result.content.nextOffset;
      }
      observed.set(absolute, await capture(version));
      if (input.line !== undefined || input.limit !== undefined) {
        const start = (input.line ?? 1) - 1;
        content = content
          .split(/(?<=\n)/)
          .slice(
            start,
            input.limit === undefined ? undefined : start + input.limit,
          )
          .join("");
      }
      return { content };
    }
    if (input.action !== "write" || typeof input.content !== "string")
      throw new Error("ACP text content is required");
    const expected = observed.get(absolute) ?? (await capture());
    const previous = JSON.parse(expected) as { mode?: number };
    const stored = await context.client.putBlob(
      Buffer.from(input.content, "utf8"),
      `acp-text:${randomUUID()}`,
      signal,
    );
    try {
      signal?.throwIfAborted();
      const result = await context.client.fileApply({
        ...address,
        operationId: `acp-write:${randomUUID()}`,
        expectedJson: expected,
        ownerId: stored.ownerId,
        targetJson: JSON.stringify({
          kind: "regular-file",
          objectHash: stored.hash,
          byteLength: stored.byteLength,
          ...(previous.mode === undefined ? {} : { mode: previous.mode }),
        }),
      });
      if (result.status === "conflict")
        throw new Error(
          "File changed since it was read. Read the current file before writing.",
        );
      if (result.status !== "applied" || typeof result.stateJson !== "string")
        throw new Error("File write did not complete");
      observed.set(absolute, result.stateJson);
      return {};
    } finally {
      await context.client.releaseBlob(stored.ownerId);
    }
  };
}
