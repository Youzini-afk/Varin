import type { JsonValue, VarinExtensionToolDeclaration } from "./types.js";

/** Detached normal JSON, preserving null and empty values and rejecting missing/non-JSON values. */
export function parseVarinToolJson(value: unknown, path = "tool value"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, (item, index) => parseVarinToolJson(item, `${path}[${index}]`));
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseVarinToolJson(item, `${path}.${key}`)]));
  }
  throw new Error(`${path} must be normal JSON`);
}

/** Schema compilation belongs to the executing Host boundary, never to an extension's claim. */
export function parseVarinExtensionToolDeclaration(value: unknown): VarinExtensionToolDeclaration {
  const declaration = parseVarinToolJson(value, "tool");
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) throw new Error("tool must be an object");
  const keys = new Set(["name", "description", "inputSchema", "outputSchema", "completion", "operation", "examples", "source"]);
  for (const key of Object.keys(declaration)) if (!keys.has(key)) throw new Error(`Unknown tool declaration field: ${key}`);
  for (const key of ["name", "description"] as const) {
    if (typeof declaration[key] !== "string" || !declaration[key].trim()) throw new Error(`tool.${key} must be a non-empty string`);
  }
  for (const key of ["inputSchema", "outputSchema"] as const) {
    const schema = declaration[key];
    if (typeof schema !== "boolean" && (!schema || typeof schema !== "object" || Array.isArray(schema))) {
      throw new Error(`tool.${key} must be a JSON Schema object or boolean`);
    }
  }
  if (declaration.completion !== "result") throw new Error("tool.completion must be result");
  if (declaration.operation !== "read" && declaration.operation !== "effect") throw new Error("tool.operation must be read or effect");
  if (declaration.examples !== undefined && !Array.isArray(declaration.examples)) throw new Error("tool.examples must be an array");
  if (declaration.source !== undefined) {
    const source = declaration.source;
    if (!source || typeof source !== "object" || Array.isArray(source)
      || typeof source.path !== "string" || !source.path.trim()
      || (source.line !== undefined && (typeof source.line !== "number" || !Number.isSafeInteger(source.line) || source.line <= 0))) {
      throw new Error("tool.source must contain a path and optional positive line number");
    }
    for (const key of Object.keys(source)) if (key !== "path" && key !== "line") throw new Error(`Unknown tool source field: ${key}`);
  }
  return declaration as unknown as VarinExtensionToolDeclaration;
}
