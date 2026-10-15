/** Image wire adapters for the Host-owned model-compute executor. */
import type { ImageModelInfo, ImageToolPurpose, ImageToolRequest } from '@varin/protocol';

export interface ImageBytes { bytes: Uint8Array; mimeType: string }
export interface ImageModel extends ImageModelInfo { baseUrl: string }
export interface ImageWireRequest { url: string; init: RequestInit; input: unknown }
export function imageMimeType(bytes: Uint8Array): string {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  const ascii = (offset: number, text: string) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'GIF8')) return 'image/gif';
  throw new Error('The image source is not a supported raster image');
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const tokenCount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function imageRequest(model: ImageModel, purpose: ImageToolPurpose, input: ImageToolRequest, images: readonly ImageBytes[], mask?: ImageBytes): ImageWireRequest {
  if (!input.prompt.trim()) throw new Error('Provide an image prompt');
  if (purpose === 'editing' && (!model.supportsEditing || !images.length)) throw new Error('Image editing requires an image-input model and an original image');
  if (purpose === 'generation' && (images.length || mask)) throw new Error('Use image_edit to supply original images or a mask');
  if (mask && !model.supportsMask) throw new Error('The selected image API does not support masks');
  const parameters = input.parameters ?? {};
  for (const [name, value] of Object.entries(parameters)) {
    if (!model.parameters.includes(name)) throw new Error(`The selected image API does not support ${name}`);
    if (name === 'count' ? !Number.isSafeInteger(value) || Number(value) < 1 : typeof value !== 'string' || !value.trim()) throw new Error(`Invalid image parameter: ${name}`);
  }
  const endpoint = new URL(model.baseUrl.replace(/\/?$/, '/'));
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Invalid image API endpoint');
  const dataUrl = (image: ImageBytes) => `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`;
  let body: NonNullable<RequestInit['body']>;
  let contentType: string | undefined;
  let payload: Record<string, unknown>;
  if (model.api === 'openrouter-images') {
    endpoint.pathname += 'chat/completions';
    payload = { model: model.modelId, modalities: ['image', 'text'], stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }, ...images.map(image => ({ type: 'image_url', image_url: { url: dataUrl(image) } }))] }],
      ...(Object.keys(parameters).length ? { image_config: { ...(parameters.aspectRatio ? { aspect_ratio: parameters.aspectRatio } : {}),
        ...(parameters.imageSize ? { image_size: parameters.imageSize } : {}) } } : {}) };
    body = JSON.stringify(payload); contentType = 'application/json';
  } else if (model.api === 'openai-images') {
    endpoint.pathname += purpose === 'editing' ? 'images/edits' : 'images/generations';
    payload = { model: model.modelId, prompt: input.prompt,
      ...(parameters.count === undefined ? {} : { n: parameters.count }), ...(parameters.size ? { size: parameters.size } : {}),
      ...(parameters.quality ? { quality: parameters.quality } : {}), ...(parameters.outputFormat ? { output_format: parameters.outputFormat } : {}),
      ...(parameters.background ? { background: parameters.background } : {}) };
    if (purpose === 'editing') {
      const form = new FormData();
      for (const [name, value] of Object.entries(payload)) form.set(name, String(value));
      for (const [index, image] of images.entries()) form.append('image[]', new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `input-${index}`);
      if (mask) form.set('mask', new Blob([new Uint8Array(mask.bytes)], { type: mask.mimeType }), 'mask.png');
      body = form;
    } else { body = JSON.stringify(payload); contentType = 'application/json'; }
  } else throw new Error('The selected image API is unavailable');
  return { url: endpoint.toString(), init: { method: 'POST', ...(contentType ? { headers: { 'content-type': contentType } } : {}), body },
    input: { purpose, parameters, imageCount: images.length, mask: Boolean(mask), payload } };
}

export function imageResponse(api: string, raw: unknown, outputFormat?: string) {
  const value = object(raw) ? raw : {};
  const images: Array<{ data?: string; url?: string; mimeType?: string }> = [];
  const texts: string[] = [];
  if (api === 'openrouter-images') {
    const choices = Array.isArray(value.choices) ? value.choices : [];
    for (const choice of choices) {
      if (!object(choice) || !object(choice.message)) continue;
      if (typeof choice.message.content === 'string') texts.push(choice.message.content);
      for (const image of Array.isArray(choice.message.images) ? choice.message.images : []) {
        if (!object(image)) continue;
        const url = typeof image.image_url === 'string' ? image.image_url : object(image.image_url) ? image.image_url.url : undefined;
        if (typeof url === 'string') images.push({ url });
      }
    }
  } else {
    for (const item of Array.isArray(value.data) ? value.data : []) {
      if (!object(item)) continue;
      if (typeof item.b64_json === 'string') images.push({ data: item.b64_json, mimeType: `image/${outputFormat ?? 'png'}` });
      else if (typeof item.url === 'string') images.push({ url: item.url });
      if (typeof item.revised_prompt === 'string') texts.push(item.revised_prompt);
    }
  }
  const usage = object(value.usage) ? value.usage : undefined;
  return { images, text: texts.join('\n'), ...(typeof value.id === 'string' ? { responseId: value.id } : {}), ...(usage ? { usage } : {}),
    tokens: { inputTokens: tokenCount(usage?.input_tokens ?? usage?.prompt_tokens), outputTokens: tokenCount(usage?.output_tokens ?? usage?.completion_tokens) },
    valid: images.length > 0 };
}

export async function resolveImageBytes(image: { data?: string; url?: string; mimeType?: string }, fetchImage: (url: string) => Promise<Response>): Promise<ImageBytes> {
  let data = image.data;
  let mimeType = image.mimeType;
  if (image.url?.startsWith('data:')) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(image.url);
    if (!match) throw new Error('Image API returned an invalid data URL');
    mimeType = match[1]; data = match[2];
  }
  if (data !== undefined) {
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== data.replace(/\s/g, '').replace(/=+$/, '') || !mimeType?.startsWith('image/')) throw new Error('Image API returned invalid image bytes');
    return { bytes, mimeType: imageMimeType(bytes) };
  }
  if (!image.url) throw new Error('Image API returned no image');
  const response = await fetchImage(image.url);
  if (!response.ok) throw new Error('Generated image could not be downloaded');
  mimeType = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (!mimeType?.startsWith('image/')) throw new Error('Generated image response is not an image');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error('Generated image is empty');
  return { bytes, mimeType: imageMimeType(bytes) };
}
