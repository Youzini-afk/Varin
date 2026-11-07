import type { JsonObject } from '@varin/extension-contract';

export type EventConditionSchema = JsonObject | boolean;
type Schema = EventConditionSchema;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const schemaObject = (schema: unknown): JsonObject => object(schema) ? schema as JsonObject : {};

/** Only the source's declared fields are offered. The Host validates the full source contract. */
export function eventConditionsValid(schema: Schema, value: unknown): boolean {
  if (schema === false) return false;
  if (schema === true) return true;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (schema.type === 'object' || schema.properties) {
    if (!object(value)) return false;
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key === 'string' && value[key] === undefined)) return false;
    return Object.entries(schemaObject(schema.properties)).every(([key, field]) => value[key] === undefined || eventConditionsValid(typeof field === 'boolean' ? field : schemaObject(field), value[key]));
  }
  if (schema.type === 'array') return Array.isArray(value) && (typeof schema.minItems !== 'number' || value.length >= schema.minItems)
    && value.every(item => eventConditionsValid(schemaObject(schema.items), item));
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value)
    && (schema.type !== 'integer' || Number.isInteger(value)) && (typeof schema.minimum !== 'number' || value >= schema.minimum) && (typeof schema.maximum !== 'number' || value <= schema.maximum);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'string') return typeof value === 'string' && (typeof schema.minLength !== 'number' || value.length >= schema.minLength);
  return true;
}
