import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ToolExecutionPlan, ToolExecutionResource } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type ToolArguments = Record<string, unknown>;

const resourceId = (kind: string, value: string): string => `${kind}:${value}`;

const normalizedPath = (value: string): string => {
  const normalized = path.normalize(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
};

/**
 * Resolve aliases through the deepest existing ancestor. New files therefore
 * share the same identity as an existing parent reached through a symlink,
 * while the Host remains the final path and mutation authority.
 */
const canonicalPath = (cwd: string, input: string): string => {
  const absolute = path.resolve(cwd, input);
  let existing = absolute;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let base = existing;
  try {
    base = realpathSync.native(existing);
  } catch {
    // The Host will report an unavailable or unauthorized path. Keeping the
    // normalized absolute identity here still preserves same-spelling order.
  }
  return normalizedPath(path.resolve(base, ...missing));
};

const pathAncestors = (canonical: string): string[] => {
  const result: string[] = [];
  let current = canonical;
  while (true) {
    const parent = normalizedPath(path.dirname(current));
    if (parent === current) break;
    result.push(resourceId("path", parent));
    current = parent;
  }
  return result;
};

const fileResource = (
  cwd: string,
  input: string,
  access: ToolExecutionResource["access"],
  scope: ToolExecutionResource["scope"] = "exact",
): ToolExecutionResource => {
  const canonical = canonicalPath(cwd, input);
  return {
    id: resourceId("path", canonical),
    access,
    scope,
    ancestors: pathAncestors(canonical),
  };
};

const stringArgument = (args: ToolArguments, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

const exactPathPlan = (
  cwd: string,
  args: ToolArguments,
  access: ToolExecutionResource["access"],
): ToolExecutionPlan => {
  const input = stringArgument(args, "path");
  return input ? { resources: [fileResource(cwd, input, access)] } : { barrier: true };
};

const subtreePathPlan = (cwd: string, args: ToolArguments): ToolExecutionPlan => ({
  resources: [fileResource(cwd, stringArgument(args, "path") ?? ".", "read", "subtree")],
});

const targetResource = (
  kind: string,
  value: string | undefined,
  access: ToolExecutionResource["access"] = "write",
): ToolExecutionPlan => value
  ? { resources: [{ id: resourceId(kind, value), access, scope: "exact" }] }
  : { barrier: true };

const PLANNED_HARNESS_TOOLS = new Set([
  "read", "write", "edit", "apply_patch", "find", "ls", "grep",
  "diagnostics", "symbols", "definition", "references", "hover", "bash",
  "get_output", "write_to_process", "kill_shell", "todo", "ask_question", "send", "merge", "submit_code",
  "update", "kill", "wait", "threads", "read_thread", "dispatch", "webfetch",
  "websearch", "explore", "recall", "related", "history", "resources",
  "research_source", "research_search", "research_decide", "materials", "document_read",
  "submit_facts", "experiment", "memory",
]);



/**
 * Owned Harness tools declare their effects here. This is an execution
 * contract, not a guess based on command text. Third-party sequential tools
 * omit the hook and remain ordered barriers in Pi.
 */
const planForHarnessTool = async (name: string, cwd: string, args: ToolArguments): Promise<ToolExecutionPlan | undefined> => {
  switch (name) {
    case "read":
      return exactPathPlan(cwd, args, "read");
    case "document_read":
      return stringArgument(args, "path") ? exactPathPlan(cwd, args, "read") : { resources: [] };
    case "write":
    case "edit":
      return exactPathPlan(cwd, args, "write");
    case "apply_patch": {
      const patch = stringArgument(args, "patch");
      if (!patch) return { barrier: true };
      // Dynamic import avoids a module cycle through workspace-mutation-journal;
      // execution and scheduling still consume one parser implementation.
      const { parseCodexPatchPaths } = await import("./apply-patch-tool.js");
      const parsed = parseCodexPatchPaths(patch);
      if ("error" in parsed) return { barrier: true };
      const paths = [...new Set(parsed.paths)];
      return paths.length > 0
        ? { resources: paths.map((entry) => fileResource(cwd, entry, "write")) }
        : { barrier: true };
    }
    case "find":
    case "ls":
    case "grep":
      return subtreePathPlan(cwd, args);
    case "diagnostics":
    case "symbols":
    case "definition":
    case "references":
    case "hover":
      return exactPathPlan(cwd, args, "read");
    case "bash":
      // Shell text is opaque. It can affect cwd, environment and arbitrary
      // files, so this remains an ordered barrier without parsing the command.
      return {
        barrier: true,
        ...(stringArgument(args, "target") ? {
          resources: [{ id: resourceId("execution-target", stringArgument(args, "target")!), access: "write", scope: "exact" as const }],
        } : {}),
      };
    case "get_output":
      // Observation waits do not own the process-control resource.
      return { resources: [] };
    case "write_to_process":
    case "kill_shell":
      return targetResource("shell", stringArgument(args, "shellId"));
    case "todo":
      return targetResource("session-state", "todo");
    case "memory":
      // An unscoped search spans note scopes, and omitted write scope depends
      // on the session role. Keep memory writes ordered with all memory reads
      // in this batch without holding unrelated tools behind them.
      return targetResource("session-state", "memory",
        ["get", "search"].includes(String(args.action)) ? "read" : "write");
    case "ask_question":
      return { resources: [] };
    case "send":
      return targetResource("thread", stringArgument(args, "threadId") ?? stringArgument(args, "to"));
    case "submit_code": {
      const receiver = targetResource("thread", stringArgument(args, "threadId"));
      if (receiver.barrier || !Array.isArray(args.files)) return receiver;
      const files = args.files.filter((file): file is { path: string } => Boolean(file) && typeof file === "object" && typeof file.path === "string");
      return { resources: [...(receiver.resources ?? []), ...files.map(file => fileResource(cwd, file.path, "read"))] };
    }
    case "merge":
    case "update":
    case "kill":
      // These lifecycle calls can publish/rebase/reclaim branch and workspace
      // state whose complete file set is resolved inside Host. Until that plan
      // is returned to Pi, they are ordered barriers rather than thread-id-only.
      return { barrier: true };
    case "dispatch":
    case "related":
      // They capture/read the current working authority. Explicit tool scope is
      // further enforced by Host, while this broad read preserves write-before-
      // capture ordering when no canonical narrow set is available to Pi yet.
      return subtreePathPlan(cwd, {});
    case "explore":
      // Retrieval reports versioned observations; it does not hold the live
      // source stable until its search and model selection have completed.
      return { resources: [] };
    case "experiment":
      return ["list", "get", "logs", "artifact", "wait"].includes(String(args.action))
        ? { resources: [] }
        : { barrier: true };
    case "wait":
    case "threads":
    case "read_thread":
    case "webfetch":
    case "websearch":
    case "research_search":
    case "research_decide":
    case "materials":
    case "recall":
    case "history":
    case "resources":
    case "research_source":
      return { resources: [] };
    default:
      return undefined;
  }
};

export const withToolExecutionResources = <T extends ToolDefinition>(
  tool: T,
  cwd: string,
): T => {
  if (!PLANNED_HARNESS_TOOLS.has(tool.name)) return tool;
  return {
    ...tool,
    prepareExecution: async (args) => (
      (await planForHarnessTool(tool.name, cwd, args as ToolArguments)) ?? { barrier: true }
    ),
    execute: async (...args: Parameters<T["execute"]>) => (
      Reflect.apply(tool.execute, tool, args) as ReturnType<T["execute"]>
    ),
  } as T;
};
