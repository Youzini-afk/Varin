/** Partial channel edits operate on the owner's original record, never a redacted projection. */
import { MODEL_CATALOG_FIELDS, type ModelChannel } from '@varin/application-client';
import { ModelConfigurationError, object } from './configuration.js';
import { compileToolJsonSchema } from './schema.js';

export interface ModelChannelPatch { set?: Record<string, unknown>; reset?: string[] }
const stringMap = { type: 'object', additionalProperties: { type: 'string' } };
const setProperties = {
  name: { type: 'string', minLength: 1 }, type: { type: 'string', minLength: 1 },
  enabled: { type: 'boolean' }, baseUrl: { type: 'string' },
  authentication: { type: 'object' }, parameters: { type: 'object' }, models: { type: 'array', items: { type: 'object' } },
  'connection.paths': stringMap, 'connection.proxy': { type: 'object' }, 'connection.headers': stringMap,
};
const modelDescriptionPath = '^models\\.[\\s\\S]+\\.description$';
const modelDescriptionId = (path: string): string | undefined =>
  path.startsWith('models.') && path.endsWith('.description') ? path.slice('models.'.length, -'.description'.length) : undefined;
const optionalPaths = ['connection', 'connection.paths', 'connection.proxy', 'connection.headers'];
export const MODEL_CHANNEL_PATCH_FIELDS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    set: { type: 'object', minProperties: 1, additionalProperties: false, properties: setProperties,
      patternProperties: { [modelDescriptionPath]: { type: 'string', description: 'Description for the literal model ID between models. and .description; an empty string explicitly clears the catalog introduction.' }, '^connection\\.headers\\.[!#$%&\'*+.^_`|~0-9A-Za-z-]+$': { type: 'string' } } },
    reset: { type: 'array', minItems: 1, uniqueItems: true, items: { anyOf: [
      { enum: optionalPaths }, { type: 'string', pattern: modelDescriptionPath, description: 'Restore the model description from current directory defaults.' }, { type: 'string', pattern: '^connection\\.headers\\.[!#$%&\'*+.^_`|~0-9A-Za-z-]+$' },
    ] } },
  },
  anyOf: [{ required: ['set'] }, { required: ['reset'] }],
};
export const MODEL_CHANNEL_PATCH_SCHEMA = {
  ...MODEL_CHANNEL_PATCH_FIELDS_SCHEMA,
  required: ['id', 'expectedRevision'],
  properties: { ...MODEL_CHANNEL_PATCH_FIELDS_SCHEMA.properties,
    id: { type: 'string', minLength: 1 }, expectedRevision: { type: 'string', minLength: 1 } },
};
const validate = compileToolJsonSchema(MODEL_CHANNEL_PATCH_FIELDS_SCHEMA);
export function applyModelChannelPatch(current: ModelChannel, patch: ModelChannelPatch): ModelChannel {
  if (!validate(patch) || Object.values(patch.set ?? {}).some(value => value === undefined)) throw new ModelConfigurationError('channel-patch-invalid', 'Use declared channel set/reset paths and valid values');
  const paths = [...Object.keys(patch.set ?? {}), ...(patch.reset ?? [])];
  if (paths.some((path, index) => paths.some((other, otherIndex) => index !== otherIndex && (other === path || (modelDescriptionId(path) === undefined || modelDescriptionId(other) === undefined) && other.startsWith(`${path}.`))))) {
    throw new ModelConfigurationError('channel-patch-invalid', 'Channel patch paths cannot overlap');
  }
  const channel = structuredClone(current);
  const next = channel as unknown as Record<string, unknown>;
  for (const path of paths) {
    const modelId = modelDescriptionId(path);
    if (modelId !== undefined) {
      const model = channel.models.find(candidate => candidate.id === modelId);
      if (!model) throw new ModelConfigurationError('model-unavailable', 'The selected channel model is missing');
      const catalog = model.catalog ?? { overrides: MODEL_CATALOG_FIELDS.filter(field => Object.hasOwn(model, field)) };
      const overrides: typeof catalog.overrides = catalog.overrides.filter(field => field !== 'description');
      if ((patch.reset ?? []).includes(path)) delete model.description;
      else { model.description = patch.set![path] as string; overrides.push('description'); }
      model.catalog = { ...catalog, overrides };
      continue;
    }
    const parts = path.startsWith('connection.headers.') ? ['connection', 'headers', path.slice('connection.headers.'.length)] : path.split('.');
    const reset = (patch.reset ?? []).includes(path);
    let target = next;
    let absent = false;
    for (const part of parts.slice(0, -1)) {
      if (!object(target[part])) {
        if (reset) { absent = true; break; }
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }
    if (absent) continue;
    const key = parts.at(-1)!;
    if (reset) delete target[key];
    else Object.defineProperty(target, key, { value: structuredClone(patch.set![path]), enumerable: true, configurable: true, writable: true });
  }
  return channel;
}
