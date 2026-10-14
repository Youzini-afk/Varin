import type { AgentSettingsSnapshot } from '@varin/application-client';
/** Image tools retain their user-selected models, original inference calls and media owners. */
import { IMAGES_CAPABILITY, IMAGE_TOOL_DECLARATIONS, imageToolDeclaration } from '@varin/extension-builtins';
import type { HostCapabilityHandler } from '@varin/extension-host';
import { parseVarinToolJson, type VarinExtensionServiceProvision } from '@varin/extension-contract';
import { parseHarnessImageSettings, type ImageModelInfo, type ImageToolPurpose, type ImageToolRequest, type ImageToolResult } from '@varin/protocol';
import type { ModelsService, InferenceProviderBinding as HostInferenceProviderBinding } from '../models/service.js';
import { imageMimeType, imageRequest, imageResponse, resolveImageBytes, type ImageBytes } from './image-model.js';
import { compileToolJsonSchema } from '../models/schema.js';
import type { EgressRuntime } from '../harness/egress.js';
import type { MediaResourceStore } from '../harness/media-resources.js';
import type { InferenceRequests } from '../knowledge/semantic/inference-requests.js';
import type { DocumentSources } from './document-sources.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExtensionToolConfiguration, ExtensionToolRun } from './extension-tool-owner.js';
import type { ExtensionToolBinding, IncomingMedia, LaunchSource, OutputPart } from './protocol.generated.js';
import { runToolDomainCall } from './tool-invocation.js';
import { threadMaterialScope } from './material-storage.js';

export { IMAGES_CAPABILITY };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const purposeOf = (descriptor: VarinExtensionServiceProvision): ImageToolPurpose | undefined => IMAGE_TOOL_DECLARATIONS.find(entry => entry.id === descriptor.id && entry.version === descriptor.version)?.id.split('.').at(-1) as ImageToolPurpose | undefined;
interface ImageConfiguration { version: 1; purpose: ImageToolPurpose; model: ImageModelInfo; baseUrl: string; configurationId: string }
function restore(identity: string | null | undefined): ImageConfiguration {
  const value: unknown = identity ? JSON.parse(identity) : null;
  if (!object(value) || value.version !== 1 || !['generation', 'editing'].includes(String(value.purpose)) || !object(value.model)
    || typeof value.model.providerId !== 'string' || typeof value.model.modelId !== 'string' || typeof value.configurationId !== 'string'
    || typeof value.baseUrl !== 'string' || !Array.isArray(value.model.parameters)) throw new Error('The original image model configuration is unavailable');
  return value as unknown as ImageConfiguration;
}
const identityOf = (purpose: ImageToolPurpose, provider: HostInferenceProviderBinding): string => JSON.stringify({ version: 1, purpose,
  model: { ...provider.imageModel!, name: provider.imageModel!.modelId }, baseUrl: provider.baseUrl, configurationId: provider.configurationId } satisfies ImageConfiguration);

export function createImageRuntime(options: {
  authority: Pick<ModelsService, 'resolveImageBinding' | 'listImageModels'>;
  settings(source: LaunchSource | null): Promise<AgentSettingsSnapshot>;
  requests: InferenceRequests;
  egress: Pick<EgressRuntime, 'prepare'>;
  media: MediaResourceStore;
  documents: DocumentSources;
  runtime: Pick<AgentRuntimeClient, 'familyList' | 'run'>;
}) {
  const retained = new Map<string, { provider: HostInferenceProviderBinding; references: number }>();
  const prepareConfiguration = async (run: ExtensionToolRun, required: readonly ExtensionToolBinding[], previous?: ExtensionToolConfiguration): Promise<ExtensionToolConfiguration> => {
    const captured = new Map<ImageToolPurpose, { identity: string; provider: HostInferenceProviderBinding } | { error: unknown }>();
    const owned = new Set<HostInferenceProviderBinding>();
    let references = 1, released = false;
    const releaseOwned = () => { if (!--references) { for (const provider of owned) provider.release?.(); previous?.release?.(); } };
    let configured: Set<ImageToolPurpose>;
    try {
      if (required.length) {
        configured = new Set();
        for (const binding of required) {
          const purpose = purposeOf({ id: binding.serviceId, version: binding.serviceVersion });
          if (!purpose) continue;
          configured.add(purpose);
          const original = restore(binding.configurationIdentity);
          const existing = retained.get(binding.configurationIdentity!)?.provider;
          const provider = existing ?? await options.authority.resolveImageBinding(original.model.providerId, original.model.modelId, purpose);
          if (existing) { const release = existing.retain?.(); if (release) owned.add({ ...existing, release }); }
          else owned.add(provider);
          if (identityOf(purpose, provider) !== binding.configurationIdentity) throw new Error('The original image model binding is unavailable');
          captured.set(purpose, { identity: binding.configurationIdentity!, provider });
        }
      } else {
        const settings = await options.settings(run.source);
        const global = object(settings.global.harness) ? settings.global.harness : {};
        const project = settings.projectTrusted && object(settings.project.harness) ? settings.project.harness : {};
        const tools = { ...(object(global.tools) ? global.tools : {}), ...(object(project.tools) ? project.tools : {}) };
        const selections = parseHarnessImageSettings(global.images);
        configured = new Set();
        await Promise.all(IMAGE_TOOL_DECLARATIONS.map(async descriptor => {
          const purpose = purposeOf(descriptor)!;
          const selection = selections[purpose];
          if (!selection || tools[descriptor.tool!.name] === false) return;
          configured.add(purpose);
          try {
            const provider = await options.authority.resolveImageBinding(selection.providerId, selection.modelId, purpose);
            owned.add(provider);
            if (purpose === 'editing' && !provider.imageModel?.supportsEditing) throw new Error('The selected image model does not accept original images');
            captured.set(purpose, { identity: identityOf(purpose, provider), provider });
          } catch (error) { captured.set(purpose, { error }); }
        }));
      }
    } catch (error) {
      configured = new Set(['generation', 'editing']);
      for (const purpose of configured) captured.set(purpose, { error });
    }
    const configuration: ExtensionToolConfiguration = (descriptor, original) => {
      const purpose = purposeOf(descriptor);
      if (!purpose) return previous?.(descriptor, original) ?? original ?? null;
      const selection = captured.get(purpose);
      if (!selection) throw new Error('This image tool has no configured model');
      if ('error' in selection) throw selection.error;
      if (original !== undefined && original !== selection.identity) throw new Error('The original image model binding changed');
      return selection.identity;
    };
    configuration.enabled = descriptor => {
      const purpose = purposeOf(descriptor);
      return purpose ? configured.has(purpose) : previous?.enabled?.(descriptor) ?? true;
    };
    configuration.declaration = (descriptor, identity) => purposeOf(descriptor)
      ? imageToolDeclaration(descriptor, restore(identity).model) : previous?.declaration?.(descriptor, identity) ?? descriptor;
    configuration.retainPreparation = () => {
      if (!references) throw new Error('Image preparation was released');
      references += 1; let done = false; return () => { if (done) return; done = true; releaseOwned(); };
    };
    configuration.release = () => { if (released) return; released = true; releaseOwned(); };
    configuration.retain = (descriptor, identity) => {
      const purpose = purposeOf(descriptor);
      if (!purpose) return previous?.retain?.(descriptor, identity) ?? (() => {});
      const capturedProvider = captured.get(purpose);
      if (!identity || !capturedProvider || 'error' in capturedProvider || capturedProvider.identity !== identity) throw new Error('The prepared image model binding is unavailable');
      const entry = retained.get(identity) ?? { provider: capturedProvider.provider, references: 0 };
      const releaseProvider = entry.provider.retain?.();
      retained.set(identity, entry); entry.references++;
      let released = false;
      return () => { if (released) return; released = true; releaseProvider?.(); if (--entry.references === 0 && retained.get(identity) === entry) retained.delete(identity); };
    };
    return configuration;
  };

  const capability: HostCapabilityHandler = async (method, value, call) => {
    const declaration = IMAGE_TOOL_DECLARATIONS.find(entry => entry.id === `varin.images.${method}`);
    if (!declaration) throw new Error('Unknown image tool');
    const input = parseVarinToolJson(value);
    return runToolDomainCall(call, { domain: IMAGES_CAPABILITY, toolName: declaration.tool!.name, operation: 'effect', arguments: input }, async invocation => {
      const config = restore(invocation.configurationIdentity);
      const provider = retained.get(invocation.configurationIdentity!)?.provider;
      if (!provider || config.purpose !== method) throw new Error('The original image model binding is unavailable');
      const validate = compileToolJsonSchema(imageToolDeclaration(declaration, config.model).tool!.inputSchema);
      if (!validate(input)) throw new Error('Image arguments do not match the selected model');
      const request = input as unknown as ImageToolRequest;
      const parts: OutputPart<IncomingMedia>[] = [];
      const result: ImageToolResult = { status: 'failed', providerId: config.model.providerId, modelId: config.model.modelId, images: [] };
      let started = false, completed = false;
      try {
        const family = await options.runtime.familyList({ callerThreadId: invocation.threadId, includeSelf: true }, call.signal);
        const owner = { kind: 'thread' as const, owningWorkspaceId: threadMaterialScope(family.rootThreadId), threadId: invocation.threadId };
        const readImage = async (source: NonNullable<ImageToolRequest['images']>[number]): Promise<ImageBytes> => {
          if ('resourceId' in source) return options.media.read(owner, source.resourceId);
          const document = await options.documents.tool(invocation).readPath!(source.path, call.signal);
          if (!(document.source instanceof Uint8Array)) throw new Error('Image source bytes are unavailable');
          return { bytes: document.source, mimeType: imageMimeType(document.source) };
        };
        const images = await Promise.all((request.images ?? []).map(readImage));
        const mask = request.mask ? await readImage(request.mask) : undefined;
        const wire = imageRequest({ ...config.model, modelId: provider.requestModelId ?? config.model.modelId, baseUrl: config.baseUrl }, config.purpose, request, images, mask);
        wire.url = provider.requestUrl;
        if (!provider.routes.some(route => route.requestUrl === wire.url)) throw new Error('The original image route changed');
        await options.requests.run(invocation, call.signal, async inference => {
          await inference.assertFresh();
          await provider.assertAvailable();
          const auth = await provider.getAuth();
          const headers = new Headers(provider.headers);
          new Headers(wire.init.headers).forEach((value, key) => headers.set(key, value));
          for (const [key, value] of Object.entries(auth?.auth.headers ?? {})) if (value !== null) headers.set(key, value);
          if (auth?.auth.apiKey && !headers.has('authorization')) headers.set('authorization', `Bearer ${auth.auth.apiKey}`);
          const response = await inference.request({ binding: { requestKind: 'model_compute', purpose: `image-${config.purpose}`, providerId: config.model.providerId,
            modelId: config.model.modelId, configurationId: config.configurationId, executor: { kind: 'http', api: provider.api, endpoint: wire.url, credentialScope: provider.credentialScope } },
            request: wire.input, destination: wire.url, init: { ...wire.init, headers, signal: call.signal }, connection: await options.egress.prepare(wire.url, provider.egressOverride),
            check: async signal => { signal.throwIfAborted(); await provider.assertAvailable(); },
            onReceipt: receipt => { started ||= receipt.requestStarted === true; completed ||= receipt.providerCompleted; },
            observe: raw => {
              const observed = imageResponse(provider.api, raw, request.parameters?.outputFormat);
              return { valid: observed.valid, rawUsage: observed.usage ?? null, usage: { measurement: observed.usage ? 'actual' : 'missing', ...observed.tokens } };
            } });
          completed = true;
          if (!response.ok) throw new Error(`Image API rejected the request (${response.status})`);
          const observed = imageResponse(provider.api, await response.json(), request.parameters?.outputFormat);
          if (observed.responseId) result.responseId = observed.responseId;
          if (observed.usage) result.usage = observed.usage;
          if (observed.text) result.text = observed.text;
          for (const image of observed.images) {
            try {
              const bytes = await resolveImageBytes(image, async url => (await options.egress.prepare(url, provider.egressOverride)).fetch(url, { redirect: 'manual' }));
              const resource = await options.media.put(owner, bytes, { operationId: invocation.operationId, responseId: observed.responseId,
                providerId: config.model.providerId, modelId: config.model.modelId, purpose: config.purpose, configurationId: config.configurationId, inputs: request.images ?? [], ...(request.mask ? { mask: request.mask } : {}), usage: observed.usage });
              // Once returned, image retention belongs to the original executor even if
              // its caller cancels. Publish only media whose stable resource is retained.
              result.images.push(resource);
              parts.push({ kind: 'media', media: { media_type: bytes.mimeType, data_base64: Buffer.from(bytes.bytes).toString('base64') } });
            } catch { result.message = 'Some generated images could not be retained'; }
          }
          result.status = parts.length ? result.images.length === observed.images.length ? 'ok' : 'partial' : 'failed';
          if (!observed.images.length) result.message = 'The image model returned no images';
        });
      } catch {
        result.status = parts.length ? 'partial' : started && !completed ? 'unknown' : call.signal.aborted ? 'cancelled' : 'failed';
        result.message = result.status === 'unknown' ? 'Image request outcome is unknown; the original request was not repeated'
          : call.signal.aborted ? 'Image work was cancelled' : 'Image work failed; check the original model request or image resource';
      }
      return { executor_stopped: true, completion: { kind: 'result', effect: started ? completed ? 'confirmed' : 'unknown' : 'none',
        outcome: result.status === 'ok' ? 'succeeded' : result.status === 'unknown' ? 'indeterminate' : result.status === 'cancelled' ? 'cancelled' : 'failed',
        content: { data: parseVarinToolJson(result), parts } } };
    });
  };
  return { capability, prepareConfiguration, models: () => options.authority.listImageModels() };
}
