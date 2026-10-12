import type { JsonValue, VarinExtensionToolDeclaration } from "./types.js";
import { parseVarinContractSource } from "./runtime-source.js";

export const VARIN_RUNTIME_TOOLS_CAPABILITY = 'runtime.tools';

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
  const keys = new Set(["name", "description", "inputSchema", "outputSchema", "completion", "lifetime", "operation", "examples", "source", "requirements"]);
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
  if (declaration.completion !== "result" && declaration.completion !== "job") throw new Error("tool.completion must be result or job");
  if (declaration.completion === "job" ? declaration.lifetime !== "thread" && declaration.lifetime !== "environment" : declaration.lifetime !== undefined) {
    throw new Error("Only a job declaration has an explicit thread or environment lifetime");
  }
  if (declaration.operation !== "read" && declaration.operation !== "effect") throw new Error("tool.operation must be read or effect");
  if (declaration.examples !== undefined && !Array.isArray(declaration.examples)) throw new Error("tool.examples must be an array");
  if (declaration.requirements !== undefined) {
    const requirement = declaration.requirements;
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)
      || !['source', 'physical', 'live'].includes(String(requirement.source)) || typeof requirement.process !== 'boolean'
      || Object.keys(requirement).some(key => key !== 'source' && key !== 'process')) throw new Error('tool.requirements must declare source and process dependencies');
  }
  if (declaration.source !== undefined) parseVarinContractSource(declaration.source);
  return declaration as unknown as VarinExtensionToolDeclaration;
}
