import { HarnessSettingsValidationError } from './harness-settings.js';
import type { JsonValue } from './types.js';
type JsonObject = Record<string, JsonValue>;

export type ImageToolPurpose = 'generation' | 'editing';
export interface ImageModelSelection { providerId: string; modelId: string }
export type HarnessImageSettings = Partial<Record<ImageToolPurpose, ImageModelSelection | null>>;
export interface ImageModelInfo extends ImageModelSelection {
  name: string;
  api: string;
  input: readonly string[];
  supportsGeneration: boolean;
  supportsEditing: boolean;
  supportsMask: boolean;
  parameters: readonly string[];
}
export interface ImageParameters {
  count?: number;
  size?: string;
  quality?: string;
  outputFormat?: 'png' | 'jpeg' | 'webp';
  background?: 'auto' | 'opaque' | 'transparent';
  aspectRatio?: string;
  imageSize?: string;
}
export type ImageSource = { resourceId: string } | { path: string };
export interface ImageToolRequest {
  prompt: string;
  images?: ImageSource[];
  mask?: ImageSource;
  parameters?: ImageParameters;
}
export interface ImageResourceReference {
  resourceId: string;
  mimeType: string;
  byteLength: number;
}
export interface ImageToolResult {
  status: 'ok' | 'partial' | 'failed' | 'cancelled' | 'unknown';
  providerId: string;
  modelId: string;
  images: ImageResourceReference[];
  text?: string;
  responseId?: string;
  message?: string;
  /** Unmodified provider accounting; absent measurements stay absent. */
  usage?: Record<string, unknown>;
}

const text = { type: 'string', minLength: 1 };
const objectSchema = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: 'object', additionalProperties: false, properties, required });
const sourceSchema = { oneOf: [objectSchema({ resourceId: text }, ['resourceId']), objectSchema({ path: text }, ['path'])] };
const parameterSchemas: JsonObject = { count: { type: 'integer', minimum: 1 }, size: text, quality: text,
  outputFormat: { enum: ['png', 'jpeg', 'webp'] }, background: { enum: ['auto', 'opaque', 'transparent'] }, aspectRatio: text, imageSize: text };
export function imageToolContract(purpose: ImageToolPurpose, model?: Pick<ImageModelInfo, 'parameters' | 'supportsMask'>) {
  return { name: purpose === 'generation' ? 'image_generate' : 'image_edit',
    description: purpose === 'generation'
      ? 'Generate images from a prompt using the configured generation model. Returns image previews and resource IDs for later editing. Parameters belong to the selected image model.'
      : 'Edit original images using the configured editing model. Images and an optional mask reference a returned resourceId or a readable source path. Returns new image previews and resource IDs; originals are retained.',
    inputSchema: objectSchema({ prompt: text, parameters: objectSchema(model ? Object.fromEntries(model.parameters.map(key => [key, parameterSchemas[key]!])) : parameterSchemas),
      ...(purpose === 'editing' ? { images: { type: 'array', minItems: 1, items: sourceSchema }, ...(model?.supportsMask === false ? {} : { mask: sourceSchema }) } : {}) },
      purpose === 'editing' ? ['prompt', 'images'] : ['prompt']) };
}

export function parseHarnessImageSettings(value: unknown): HarnessImageSettings {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessSettingsValidationError('harness.images must be an object');
  const result: HarnessImageSettings = {};
  for (const [key, binding] of Object.entries(value)) {
    if (key !== 'generation' && key !== 'editing') throw new HarnessSettingsValidationError(`Unknown image tool: ${key}`);
    if (binding === null) { result[key] = null; continue; }
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).some(field => field !== 'providerId' && field !== 'modelId')
      || !('providerId' in binding) || typeof binding.providerId !== 'string' || !binding.providerId.trim()
      || !('modelId' in binding) || typeof binding.modelId !== 'string' || !binding.modelId.trim()) {
      throw new HarnessSettingsValidationError(`harness.images.${key} requires providerId and modelId`);
    }
    result[key] = { providerId: binding.providerId, modelId: binding.modelId };
  }
  return result;
}

export function imageModelInfo(model: { provider: string; id: string; name: string; api: string; input: readonly string[] }): ImageModelInfo | null {
  if (model.api !== 'openrouter-images' && model.api !== 'openai-images') return null;
  const supportsEditing = model.input.includes('image');
  return { providerId: model.provider, modelId: model.id, name: model.name, api: model.api, input: [...model.input], supportsGeneration: true, supportsEditing,
    supportsMask: supportsEditing && model.api === 'openai-images',
    parameters: model.api === 'openai-images' ? ['count', 'size', 'quality', 'outputFormat', 'background'] : ['aspectRatio', 'imageSize'] };
}
