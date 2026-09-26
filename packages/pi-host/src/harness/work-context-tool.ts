import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { WorkContextSync } from "./work-context.js";

const WorkContextParams = Type.Object({
  action: Type.Union([
    Type.Literal("get"),
    Type.Literal("discover"),
    Type.Literal("select"),
    Type.Literal("scope"),
    Type.Literal("reset"),
  ], { description: "get: read context. discover: list candidate project dirs. select: switch the operation dir. scope: restrict retrieval scope. reset: restore the session launch dir." }),
  /** select: directory to operate in. discover: optional start directory. */
  path: Type.Optional(Type.String({ description: "select: target directory, absolute or relative to the workspace root." })),
  /** scope: retrieval roots; empty array clears the scope. */
  paths: Type.Optional(Type.Array(Type.String({ description: "absolute or workspace-root-relative path" }))),
  /** CAS guard from a prior get/select/scope/reset result. */
  expectedRevision: Type.Optional(Type.Number({ description: "Reject the mutation unless the Host context still has this revision." })),
  /** discover: opaque continuation token from a previous partial result. */
  cursor: Type.Optional(Type.String()),
  /** discover: preferred per-page candidate count (default 50). */
  maxResults: Type.Optional(Type.Number()),
  /** discover: optional maximum depth below the start directory; omitted scans descendants. */
  depth: Type.Optional(Type.Number()),
});

/**
 * Agent-facing handle on the Host-owned work context (RR2). Mutations apply
 * the returned authoritative state to the session mirror so every later
 * relative path resolves consistently across native Pi tools and Host
 * services.
 */
export function createWorkContextTool(bridge: HostServicesBridge, sync: WorkContextSync): ToolDefinition {
  return defineTool({
    name: "work_context",
    label: "Work Context",
    description:
      "View or change this session's work context inside the authorized workspace. "
      + "The operation dir anchors relative file paths and the default shell start directory. A shell's cd affects only that shell. "
      + "Use discover to list candidate project dirs, select to switch into one, scope to restrict retrieval, reset to return to the session launch dir.",
    promptSnippet: "work_context: view/select the session operation dir and retrieval scope within the authorized workspace",
    promptGuidelines: [
      "Relative file paths resolve against the operation dir shown by work_context get; a persistent shell may have its own cwd after cd.",
      "Call work_context discover when the workspace may contain multiple projects, then select the intended one before reading or editing files.",
      "Pass expectedRevision when acting on a previously read context so a concurrent change is not silently overwritten.",
    ],
    parameters: WorkContextParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const requestOptions = signal === undefined ? {} : { signal };
      const expectedRevision = params.expectedRevision ?? sync.mirror.revision ?? undefined;
      switch (params.action) {
        case "get": {
          const result = await bridge.request("context.get", {}, requestOptions);
          sync.apply(result);
          return ok(result);
        }
        case "discover": {
          const result = await bridge.request("context.discover", {
            ...(params.path !== undefined ? { path: params.path } : {}),
            ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
            ...(params.maxResults !== undefined ? { maxResults: params.maxResults } : {}),
            ...(params.depth !== undefined ? { depth: params.depth } : {}),
          }, requestOptions);
          return ok(result);
        }
        case "select": {
          if (typeof params.path !== "string" || params.path.length === 0) {
            throw new Error("work_context select requires a path");
          }
          const result = await bridge.request("context.select", {
            path: params.path,
            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
          }, requestOptions);
          sync.apply(result);
          return ok(result);
        }
        case "scope": {
          if (!Array.isArray(params.paths)) {
            throw new Error("work_context scope requires a paths array (empty array clears the scope)");
          }
          const result = await bridge.request("context.scope", {
            paths: params.paths,
            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
          }, requestOptions);
          sync.apply(result);
          return ok(result);
        }
        case "reset": {
          const result = await bridge.request("context.reset", {
            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
          }, requestOptions);
          sync.apply(result);
          return ok(result);
        }
      }
    },
  });
}

const ok = (result: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  details: result,
});
