import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  HARNESS_TOOL_META,
  type PermissionAction,
  type PermissionInspectParams,
  type PermissionInspectResult,
  type PermissionPolicy,
  type PermissionToolSource,
} from "@varin/protocol";

export interface PiToolSourceInfo {
  path: string;
  source: string;
  scope: string;
  origin: string;
  baseDir?: string;
}

export interface PiToolInfoLike {
  name: string;
  description?: string;
  sourceInfo: PiToolSourceInfo;
}

const READ_TOOLS = new Set([
  "read", "grep", "find", "ls", "glob", "diagnostics", "symbols", "definition",
  "references", "hover", "get_output", "threads", "wait", "read_thread", "recall",
  "related", "explore", "history",
]);
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "merge", "update"]);
const PROCESS_TOOLS = new Set(["bash", "write_to_process", "kill_shell"]);
const THREAD_TOOLS = new Set(["dispatch", "send", "kill", "submit_facts", "todo"]);
const NETWORK_TOOLS = new Set(["webfetch", "websearch", "research_search"]);

function routedExecutionTarget(params: Record<string, unknown>): string {
  const explicit = typeof params.target === "string" ? params.target.trim() : "";
  if (explicit) return explicit === "local" ? "" : explicit;
  const handle = [params.handle, params.shellId]
    .find((value): value is string => typeof value === "string" && value.startsWith("mrsh:"));
  if (!handle) return "";
  try {
    const route = JSON.parse(Buffer.from(handle.slice(5), "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof route.machineId === "string" ? route.machineId.trim() : "";
  } catch { return ""; }
}

const packageish = (sourceInfo: PiToolSourceInfo): boolean => (
  sourceInfo.origin === "package" || sourceInfo.source.startsWith("npm:")
  || sourceInfo.source.startsWith("git:") || sourceInfo.source.startsWith("github:")
  || sourceInfo.source.startsWith("local:")
);

export function classifyPermissionToolSource(tool: PiToolInfoLike | undefined, toolName: string): PermissionToolSource {
  const sourceInfo = tool?.sourceInfo;
  if (!sourceInfo) return { kind: "unknown", id: `unknown:${toolName}` };
  if (sourceInfo.source === "builtin") return { kind: "builtin", id: `builtin:${toolName}`, scope: sourceInfo.scope };
  if (sourceInfo.source === "sdk") {
    return HARNESS_TOOL_META[toolName]
      ? { kind: "harness", id: `harness:${toolName}`, scope: sourceInfo.scope }
      : { kind: "sdk", id: `sdk:${toolName}`, scope: sourceInfo.scope };
  }
  const mcpEvidence = `${sourceInfo.source}\n${sourceInfo.path}\n${sourceInfo.baseDir ?? ""}`.toLowerCase();
  if (mcpEvidence.includes("mcp")) return { kind: "mcp", id: `mcp:${toolName}`, scope: sourceInfo.scope };
  if (packageish(sourceInfo)) return { kind: "package", id: `package:${toolName}`, scope: sourceInfo.scope };
  return { kind: "unknown", id: `unknown:${toolName}`, scope: sourceInfo.scope };
}

export function classifyPermissionAction(toolName: string, source: PermissionToolSource, params?: Record<string, unknown>): PermissionAction {
  if (source.kind === "mcp" || source.kind === "package" || source.kind === "unknown") return "unknown";
  if (toolName === "experiment") {
    return ["list", "get", "logs", "artifact", "wait"].includes(String(params?.action)) ? "read" : "process";
  }
  if (toolName === "research_source") return params?.action === "list" ? "read" : "thread";
  if (NETWORK_TOOLS.has(toolName)) return "network";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (PROCESS_TOOLS.has(toolName)) return "process";
  if (THREAD_TOOLS.has(toolName)) return "thread";
  if (READ_TOOLS.has(toolName)) return "read";
  const meta = HARNESS_TOOL_META[toolName];
  if (meta?.permissionAction) return meta.permissionAction;
  if (meta?.mutation === "journaled") return "write";
  if (meta?.mutation === "process") return "process";
  if (meta?.mutation === "none") return "read";
  // Pi built-ins are maintained by Varin explicitly. Unknown package/MCP
  // tools do not inherit authority from their own descriptions/annotations.
  if (source.kind === "builtin") {
    if (["read", "grep", "find", "ls"].includes(toolName)) return "read";
    if (["write", "edit"].includes(toolName)) return "write";
    if (toolName === "bash") return "process";
  }
  return "unknown";
}

function patchPaths(patch: unknown): string[] {
  if (typeof patch !== "string") return [];
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((path): path is string => Boolean(path));
}

function directPaths(toolName: string, params: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of ["path", "file_path", "cwd"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  if (toolName === "explore" && Array.isArray(params.paths)) {
    values.push(...params.paths.filter((value): value is string => typeof value === "string" && Boolean(value.trim())));
  }
  if (toolName === "apply_patch") values.push(...patchPaths(params.patch));
  return values;
}

/**
 * Conservatively extracts path-shaped shell arguments and redirections. This is
 * not a shell interpreter: unsupported/ambiguous constructs mark evidence
 * incomplete so Smart/session grants cannot silently widen authority.
 */
function shellEvidence(command: unknown): { paths: string[]; complete: boolean } {
  if (typeof command !== "string" || !command.trim()) return { paths: [], complete: false };
  const paths: string[] = [];
  let complete = true;
  if (/\$\(|`|<<|\beval\b|\b(?:sh|bash|zsh|pwsh|powershell|cmd)\s+-c\b/i.test(command)) complete = false;
  const tokenPattern = /(?:^|\s)(?:>{1,2}|<{1,2})\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g;
  for (const match of command.matchAll(tokenPattern)) {
    const raw = match[1]?.replace(/^(?:"|')|(?:"|')$/g, "").trim();
    if (raw) paths.push(raw);
  }
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^["']|["';|&]+$/g, "");
    if (!token || token.startsWith("-") || /^https?:\/\//i.test(token)) continue;
    if (token.startsWith("./") || token.startsWith("../") || token.startsWith("~/") || isAbsolute(token)) {
      paths.push(token);
    }
  }
  return { paths: [...new Set(paths)], complete };
}

function networkOrigins(toolName: string, params: Record<string, unknown>): string[] {
  if (toolName !== "webfetch") return [];
  const value = params.url;
  if (typeof value !== "string") return [];
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    return [url.origin.toLowerCase()];
  } catch {
    return [];
  }
}

function threadScopes(toolName: string, params: Record<string, unknown>): string[] {
  if (PROCESS_TOOLS.has(toolName) || toolName === "get_output") {
    const target = routedExecutionTarget(params);
    return target ? [`execution-target:${target}`] : [];
  }
  if (toolName === "experiment") {
    return ["action", "attemptId", "machineId", "specId"].flatMap((key) => (
      typeof params[key] === "string" ? [`experiment:${key}:${params[key]}`] : []
    ));
  }
  if (toolName !== "dispatch") return [];
  const preset = typeof params.preset === "string" ? params.preset.trim() : "";
  const capability = typeof params.capability === "string" ? params.capability.trim() : "";
  const scope = Array.isArray(params.scope)
    ? params.scope.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
  return [...new Set([
    ...(preset ? [`preset:${preset}`] : []),
    ...(capability ? [`research:${capability}`] : []),
    ...scope.map((item) => `scope:${item}`),
  ])];
}

export function buildPermissionInspection(input: {
  cwd: string;
  toolName: string;
  params: Record<string, unknown>;
  tool: PiToolInfoLike | undefined;
}): PermissionInspectParams {
  const source = classifyPermissionToolSource(input.tool, input.toolName);
  const action = classifyPermissionAction(input.toolName, source, input.params);
  const shell = input.toolName === "bash"
    ? shellEvidence(input.params.command)
    : input.toolName === "write_to_process"
      ? shellEvidence(input.params.text)
      : { paths: [] as string[], complete: true };
  const remoteTarget = Boolean(routedExecutionTarget(input.params));
  const paths = (remoteTarget ? [] : [...new Set([...directPaths(input.toolName, input.params), ...shell.paths])])
    .map((path) => path.startsWith("~/") ? path : resolve(input.cwd, path));
  const networkTargets = networkOrigins(input.toolName, input.params);
  const scopes = threadScopes(input.toolName, input.params);
  const evidenceComplete = shell.complete
    && action !== "unknown"
    && (input.toolName !== "webfetch" || networkTargets.length === 1);
  return {
    tool: input.toolName,
    source,
    action,
    cwd: input.cwd,
    paths,
    networkTargets,
    threadScopes: scopes,
    evidenceComplete,
  };
}

export function permissionPolicyGeneration(policy: PermissionPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 16);
}

export function permissionGrantKey(target: PermissionInspectResult): string {
  return JSON.stringify({
    source: target.source,
    action: target.action,
    owningWorkspaceId: target.owningWorkspaceId,
    executionWorkspaceId: target.executionWorkspaceId,
    cwd: target.cwd,
    paths: target.paths.map((path) => path.canonicalResourceId).sort(),
    networkTargets: [...target.networkTargets].sort(),
    threadScopes: [...target.threadScopes].sort(),
  });
}
