/** Host-enforced nested-thread scope and tool checks. */

export const THREAD_CONTROL_TOOL_NAMES = [
  "dispatch",
  "threads",
  "wait",
  "send",
  "read_thread",
  "history",
  "merge",
  "submit_code",
  "update",
  "kill",
] as const;

export type ThreadControlToolName = (typeof THREAD_CONTROL_TOOL_NAMES)[number];

const isAbsoluteThreadScope = (value: string, normalized: string): boolean => (
  normalized.startsWith("/")
  || normalized.startsWith("\\")
  || /^[A-Za-z]:/.test(value)
  || /^[A-Za-z]:/.test(normalized)
);

export const parseThreadScopePath = (
  value: string,
): { ok: true; path: string } | { ok: false; path: string } => {
  const slashNormalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (isAbsoluteThreadScope(value, slashNormalized)) return { ok: false, path: value };
  const parts = slashNormalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.includes("..")) return { ok: false, path: value };
  return { ok: true, path: parts.length === 0 ? (slashNormalized === "." ? "." : "") : parts.join("/") };
};

export const normalizeThreadScopePath = (value: string): string => {
  const parsed = parseThreadScopePath(value);
  if (!parsed.ok) {
    throw new Error(`Thread scope must be a relative workspace path without '..': ${value}`);
  }
  return parsed.path;
};

const normalizeScopeList = (
  paths: readonly string[],
): { ok: true; paths: string[] } | { ok: false; expanded: string[] } => {
  const expanded: string[] = [];
  const normalized: string[] = [];
  for (const path of paths) {
    const parsed = parseThreadScopePath(path);
    if (!parsed.ok) expanded.push(path);
    else normalized.push(parsed.path);
  }
  return expanded.length > 0 ? { ok: false, expanded } : { ok: true, paths: normalized };
};

export const scopePathContainedBy = (parentScope: string, childPath: string): boolean => {
  const parentParsed = parseThreadScopePath(parentScope);
  const childParsed = parseThreadScopePath(childPath);
  if (!parentParsed.ok || !childParsed.ok) return false;
  const parent = parentParsed.path;
  const child = childParsed.path;
  if (!parent || parent === ".") return true;
  if (!child || child === ".") return false;
  return child === parent || child.startsWith(`${parent}/`);
};

export const resolveNestedThreadScope = (
  parentScope: readonly string[],
  requested: readonly string[] | undefined,
): { ok: true; scope: string[] } | { ok: false; expanded: string[] } => {
  const parentNormalized = normalizeScopeList(parentScope);
  if (!parentNormalized.ok) return parentNormalized;
  if (parentNormalized.paths.length === 0) {
    if (!requested?.length) return { ok: true, scope: [] };
    const requestedNormalized = normalizeScopeList(requested);
    return requestedNormalized.ok
      ? { ok: true, scope: requestedNormalized.paths }
      : requestedNormalized;
  }
  if (!requested?.length) return { ok: true, scope: [...parentNormalized.paths] };
  const requestedNormalized = normalizeScopeList(requested);
  if (!requestedNormalized.ok) return requestedNormalized;
  const expanded = requestedNormalized.paths.filter((path) => (
    !parentNormalized.paths.some((root) => scopePathContainedBy(root, path))
  ));
  if (expanded.length > 0) return { ok: false, expanded };
  return { ok: true, scope: [...requestedNormalized.paths] };
};
