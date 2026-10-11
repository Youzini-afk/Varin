/** The 2025-11-25 elicitation decoder. This owns both form presentation and submission validation. */
import type { ValidateFunction } from 'ajv';
import type { McpElicitationField, McpElicitationPresentation, McpElicitationResponse } from '@varin/protocol';
import { compileToolJsonSchema } from './tool-schema.js';
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (): never => { throw Object.assign(new Error('mcp_interaction_request_invalid'), {code:'mcp_interaction_request_invalid'}); };
const allowed = (v: Record<string, unknown>, keys: readonly string[]) => { if (Object.keys(v).some(k => !keys.includes(k))) invalid(); };
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
function options(v: Record<string, unknown>, titled: 'oneOf' | 'anyOf'): { value: string; title: string }[] {
  if (strings(v.enum) && v.enum.length) {
    if (v.enumNames !== undefined && (!strings(v.enumNames) || v.enumNames.length !== v.enum.length)) invalid();
    return v.enum.map((value, i) => ({ value, title: (v.enumNames as string[] | undefined)?.[i] ?? value }));
  }
  if (Array.isArray(v[titled]) && v[titled].length) return (v[titled] as unknown[]).map(item => {
    if (!object(item) || typeof item.const !== 'string' || typeof item.title !== 'string') return invalid();
    allowed(item, ['const', 'title']); return { value: item.const, title: item.title };
  });
  return invalid();
}
export interface DecodedElicitation {
  request: Record<string, unknown>;
  presentation: McpElicitationPresentation;
  validate?: ValidateFunction;
}
export function decodeElicitationRequest(input: unknown): DecodedElicitation {
  if (!object(input) || typeof input.message !== 'string' || input.task !== undefined
    || input._meta !== undefined && !object(input._meta)) return invalid();
  const request = structuredClone(input);
  if (input.mode === 'url') {
    if (typeof input.url !== 'string' || typeof input.elicitationId !== 'string' || !input.elicitationId) return invalid();
    let url: URL; try { url = new URL(input.url); } catch { return invalid(); }
    // The public UI opens only an external web browser; never dispatch a command/file scheme.
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return invalid();
    return { request, presentation: { mode: 'url', message: input.message, url: input.url, elicitationId: input.elicitationId } };
  }
  if (input.mode !== undefined && input.mode !== 'form') return invalid();
  const schema = input.requestedSchema;
  if (!object(schema) || schema.type !== 'object' || !object(schema.properties)
    || (schema.required !== undefined && !strings(schema.required))) return invalid();
  allowed(schema, ['type', 'properties', 'required', '$schema']);
  const required = new Set((schema.required ?? []) as string[]);
  if ([...required].some(key => !Object.hasOwn(schema.properties as object, key))) return invalid();
  const validationSchema = structuredClone(schema);
  const fields: McpElicitationField[] = Object.entries(schema.properties).map(([name, raw]) => {
    if (!object(raw) || typeof raw.type !== 'string') return invalid();
    if (raw.title !== undefined && typeof raw.title !== 'string' || raw.description !== undefined && typeof raw.description !== 'string') return invalid();
    const base = ['type', 'title', 'description', 'default'];
    let kind: McpElicitationField['kind'], choices: McpElicitationField['options'];
    if (raw.type === 'string') {
      kind = raw.enum !== undefined || raw.oneOf !== undefined ? 'enum' : 'string';
      allowed(raw, [...base, 'enum', 'enumNames', 'oneOf', 'minLength', 'maxLength', 'format', 'pattern']);
      if (kind === 'enum') choices = options(raw, 'oneOf');
      if (raw.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(String(raw.format))) return invalid();
      if (raw.pattern !== undefined && typeof raw.pattern !== 'string') return invalid();
      // enumNames is presentation-only protocol vocabulary, not a JSON Schema keyword.
      delete (validationSchema.properties as Record<string, Record<string, unknown>>)[name]!.enumNames;
    } else if (raw.type === 'array') {
      allowed(raw, [...base, 'items', 'minItems', 'maxItems']);
      if (!object(raw.items)) return invalid();
      allowed(raw.items, ['type', 'enum', 'anyOf']);
      if (raw.items.enum !== undefined && raw.items.type !== 'string') return invalid();
      choices = options(raw.items, 'anyOf'); kind = 'multi_enum';
    } else if (raw.type === 'number' || raw.type === 'integer') {
      allowed(raw, [...base, 'minimum', 'maximum']); kind = raw.type;
    } else if (raw.type === 'boolean') { allowed(raw, base); kind = 'boolean'; }
    else return invalid();
    const field: McpElicitationField = { name, title: typeof raw.title === 'string' ? raw.title : name,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}), required: required.has(name), kind,
      ...(choices ? { options: choices } : {}) };
    for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'format', 'pattern', 'default'] as const)
      if (raw[key] !== undefined) (field as unknown as Record<string, unknown>)[key] = structuredClone(raw[key]);
    return field;
  });
  let validate: ValidateFunction;
  try {
    validate = compileToolJsonSchema(validationSchema);
    // Defaults are optional UI values, never applied to a submitted answer. JSON Schema
    // treats them as annotations, so explicitly validate each against its original field.
    for (const [name, raw] of Object.entries(validationSchema.properties as Record<string, Record<string, unknown>>)) {
      if (!Object.hasOwn(raw, 'default')) continue;
      const validateDefault = compileToolJsonSchema({
        ...(schema.$schema === undefined ? {} : {$schema: schema.$schema}),
        type: 'object', properties: {[name]: raw}, required: [name],
      });
      if (!validateDefault({[name]: raw.default})) return invalid();
    }
  } catch { return invalid(); }
  return { request, presentation: { mode: 'form', message: input.message, fields }, validate };
}
export function validateElicitationResponse(request: unknown, input: unknown): McpElicitationResponse {
  const decoded = decodeElicitationRequest(request);
  const fail = (): never => { throw Object.assign(new Error('mcp_interaction_response_invalid'), {code:'mcp_interaction_response_invalid'}); };
  if (!object(input) || !['accept', 'decline', 'cancel'].includes(String(input.action))
    || Object.keys(input).some(k => !['action', 'content'].includes(k))) return fail();
  if (input.action !== 'accept' || decoded.presentation.mode === 'url') {
    if (input.content !== undefined) return fail();
  } else {
    if (!object(input.content) || !decoded.validate!(input.content)) return fail();
    if (Object.values(input.content).some(v => !(typeof v === 'string' || typeof v === 'boolean'
      || typeof v === 'number' && Number.isFinite(v) || strings(v)))) return fail();
    const properties = decoded.request.requestedSchema as { properties: Record<string, unknown> };
    if (Object.keys(input.content).some(key => !Object.hasOwn(properties.properties, key))) return fail();
  }
  return structuredClone(input) as McpElicitationResponse;
}
