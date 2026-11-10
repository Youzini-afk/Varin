import type { JsonValue, VarinExtensionToolDeclaration } from "./types.js";
import { parseVarinContractSource } from "./runtime-source.js";

export const VARIN_TOOL_CONFIRMATION_CAPABILITY = 'varin.tools.confirmation';

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
  const keys = new Set(["name", "description", "inputSchema", "outputSchema", "completion", "lifetime", "operation", "confirmation", "examples", "source", "requirements", "disclosure", "references"]);
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
  if (declaration.confirmation !== undefined && declaration.confirmation !== "always") throw new Error("tool.confirmation must be always");
  if (declaration.examples !== undefined && !Array.isArray(declaration.examples)) throw new Error("tool.examples must be an array");
  if (declaration.requirements !== undefined) {
    const requirement = declaration.requirements;
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)
      || !['source', 'physical', 'live'].includes(String(requirement.source)) || typeof requirement.process !== 'boolean'
      || Object.keys(requirement).some(key => key !== 'source' && key !== 'process')) throw new Error('tool.requirements must declare source and process dependencies');
  }
  if (declaration.references !== undefined) {
    const refs = declaration.references;
    const record = (v: unknown): v is Record<string, JsonValue> => !!v && typeof v === 'object' && !Array.isArray(v);
    const field = (v: unknown): v is string => typeof v === 'string' && !!v && !['__proto__', 'prototype', 'constructor'].includes(v);
    if (!record(refs) || Object.keys(refs).some(key => !['inputs', 'outputs'].includes(key))) throw new Error('tool.references must declare inputs and/or outputs');
    for (const direction of ['inputs', 'outputs']) {
      const positions = refs[direction];
      if (positions === undefined) continue;
      if (!Array.isArray(positions)) throw new Error('tool.references positions must be an array');
      for (const position of positions) {
        if (!record(position) || Object.keys(position).some(key => !['path', 'kind', 'owner', 'reference', 'fields', 'omit'].includes(key))
          || typeof position.path !== 'string' || position.path !== '' && !position.path.startsWith('/')
          || position.path.split('/').slice(1).some(segment => !field(segment.replace(/~1/g, '/').replace(/~0/g, '~')) || /~(?![01])/.test(segment))
          || !['message','item','file','media','read','process','script','page','observation','settings','material','followup','forward','job','report'].includes(String(position.kind))
          || !field(position.owner) || !field(position.reference)
          || !Array.isArray(position.fields) || !position.fields.length || !position.fields.every(field)
          || position.omit !== undefined && (!Array.isArray(position.omit) || !position.omit.every(field))) throw new Error('Invalid typed tool reference position');
      }
    }
  }
  if (declaration.source !== undefined) parseVarinContractSource(declaration.source);
  if (declaration.disclosure !== undefined) {
    const disclosure = declaration.disclosure;
    const record = (value: JsonValue | undefined): value is Record<string, JsonValue> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
    const text = (value: JsonValue | undefined): value is string => typeof value === 'string' && Boolean(value.trim());
    if (!record(disclosure) || !text(disclosure.summary) || Object.keys(disclosure).some(key => !['summary','aliases','namespace','operations'].includes(key))
      || disclosure.namespace !== undefined && !text(disclosure.namespace)
      || disclosure.aliases !== undefined && (!Array.isArray(disclosure.aliases) || !disclosure.aliases.every(text))) throw new Error('tool.disclosure must declare a summary and optional aliases/namespace/operations');
    if (disclosure.operations !== undefined) {
      if (!Array.isArray(disclosure.operations)) throw new Error('tool.disclosure.operations must be an array');
      const names = new Set<string>();
      for (const operation of disclosure.operations) {
        if (!record(operation) || !text(operation.name) || !text(operation.description) || names.has(operation.name)
          || Object.keys(operation).some(key => !['name','description','paths'].includes(key))
          || !Array.isArray(operation.paths) || !operation.paths.length || !operation.paths.every(path => {
            if (typeof path !== 'string' || !/\/(oneOf|anyOf)\/\d+$/.test(path)) return false;
            let node: JsonValue | undefined = declaration.inputSchema;
            for (const segment of path.slice(1).split('/').map(key => key.replace(/~1/g,'/').replace(/~0/g,'~'))) {
              node = Array.isArray(node) ? node[Number(segment)] : record(node) ? node[segment] : undefined;
            }
            return typeof node === 'boolean' || record(node);
          })) throw new Error('tool.disclosure operation must name existing oneOf/anyOf branches');
        names.add(operation.name);
      }
    }
  }
  return declaration as unknown as VarinExtensionToolDeclaration;
}
