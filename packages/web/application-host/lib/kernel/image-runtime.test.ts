import { describe, expect, test } from 'vitest';
import { IMAGE_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import type { ImageToolRequest } from '@varin/protocol';
import { createImageRuntime } from './image-runtime.js';
import { imageMimeType, resolveImageBytes } from './image-model.js';
import { createInferenceRequests } from '../knowledge/semantic/inference-requests.js';
import { withToolInvocation } from './tool-invocation.js';
import { toolOperationId } from './protocol.generated.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const owner = { extensionId: 'varin.builtin.images', entrypointId: 'host', extensionVersion: '1', instanceKey: 'images', generation: 1 };
const executorOwner = { kind: 'host' as const, host_id: 'host', instance_id: 'executor' };
function fixture() {
  const controller = new AbortController();
  const requests: any[] = [], stored: any[] = [], published: any[] = [], fetches: string[] = [];
  const statuses = new Map<string, any>();
  let owned = 0;
  let network: {path?:string;headers?:Record<string,string>;proxy?:unknown} = {};
  const dispatched: any[] = [];
  let download: (url: string, init?: RequestInit) => Promise<Response> = async () => new Response(png, { headers: { 'content-type': 'image/png' } });
  let payload: unknown = { data: [{ b64_json: Buffer.from(png).toString('base64') }], usage: { input_tokens: 12, output_tokens: 8, images: 1, cost: 0.03 } };
  let afterReceipt: (() => void) | undefined;
  let retentionFailure = false;
  const listeners = new Set<() => void>();
  const lifecycle = { onEvent: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); }, onReady: () => () => {}, onExit: () => () => {} };
  const kernel = { agentRuntimeRequest: async (method: string, value: any) => {
    requests.push({ method, value });
    if (method === 'runtime.inference.admit') {
      const id = `inference:${value.parentOperationId}:${value.ordinal}`;
      if (!statuses.has(id)) statuses.set(id, { operationId: id, live: true, dispatched: false, phase: 'prepared' });
      return statuses.get(id);
    }
    const state = statuses.get(value.operationId);
    if (method === 'runtime.inference.dispatch') { state.dispatched = true; return state; }
    if (method === 'runtime.inference.settle') { published.push(value); Object.assign(state, { phase: 'terminal', live: false, receipt: value.receipt }); afterReceipt?.(); return state; }
    if (method === 'runtime.inference.status') return state;
    if (method === 'runtime.inference.session') return { hasRequests: [...statuses.keys()].some(id => id.startsWith(`inference:${value.parentOperationId}:`)) };
    throw new Error(`Unexpected request ${method}`);
  } };
  const egress = { prepare: async (url: string, override?: unknown) => ({ fetch: async (destination: string, init?: RequestInit) => {
    fetches.push(destination); dispatched.push({ destination, headers: new Headers(init?.headers), override });
    if (new URL(url).hostname === 'image.example') return Response.json(payload);
    return download(destination, init);
  } }) };
  const inference = createInferenceRequests({ kernel: kernel as any, runtime: lifecycle as any, egress: egress as any });
  let selection: any = { generation: { providerId: 'images', modelId: 'model' } };
  let endpoint = 'https://image.example/v1';
  const authority = { listImageModels: async () => [], resolveImageBinding: async (_provider: string, _model: string, purpose: string) => {
    const baseUrl = endpoint;
    const route = network.path ? `${baseUrl}${network.path}` : `${baseUrl}/images/${purpose === 'editing' ? 'edits' : 'generations'}`;
    owned += 1; let baseReleased = false;
    return { retain: () => { owned += 1; let released = false; return () => { if (!released) { released = true; owned -= 1; } }; },
      release: () => { if (!baseReleased) { baseReleased = true; owned -= 1; } },
      headers: network.headers, egressOverride: network.proxy, providerId: 'images', modelId: 'model', requestModelId: 'deployment', api: 'openai-images', baseUrl, requestUrl: route,
      configurationId: baseUrl, credentialScope: { reference: 'images', authority: 'credentials', account: 'account', generation: 1 },
      routes: [{ requestUrl: route, requestKind: 'model_compute' }],
      imageModel: { providerId: 'images', modelId: 'model', name: 'Image model', api: 'openai-images', input: ['text', 'image'], supportsGeneration: true, supportsEditing: true, supportsMask: true, parameters: ['count'] },
      assertAvailable: async () => {}, getAuth: async () => ({ auth: { apiKey: 'key' } }),
    };
  } };
  const images = createImageRuntime({ authority: authority as any, settings: async () => ({ global: { harness: { images: selection } }, project: {}, projectTrusted: false } as any),
    requests: inference, egress: egress as any, media: { put: async (scope: any, bytes: any, provenance: any) => {
      if (retentionFailure) throw new Error('storage unavailable');
      stored.push({ scope, bytes, provenance }); return { resourceId: `resource-${stored.length}`, mimeType: bytes.mimeType, byteLength: bytes.bytes.length };
    }, read: async () => ({ bytes: png, mimeType: 'image/png' }) },
    documents: { tool: () => ({ readPath: async () => ({ source: png }) }) } as any,
    runtime: { familyList: async () => ({ rootThreadId: 'root' }) } as any });
  async function invoke(input: ImageToolRequest = { prompt: 'A landscape' }, purpose = 'generation') {
    const declaration = IMAGE_TOOL_DECLARATIONS.find(item => item.id.endsWith(`.${purpose}`))!;
    const configuration = await images.prepareConfiguration({ source: null } as any, []);
    const identity = configuration(declaration);
    const release = configuration.retain!(declaration, identity);
    const origin = { kind: 'model_step' as const, request_id: 'exchange' };
    const operationId = toolOperationId(origin, 'call');
    let receipt: ToolExecutionReceipt | undefined;
    try {
      const data = await withToolInvocation({ owner, signal: controller.signal,
        authority: { invocationId: 'invocation', runId: 'run', threadId: 'thread', operationId, callId: 'call', executorOwner: executorOwner as any,
          origin, source: null, toolName: declaration.tool!.name, operation: 'effect', completion: 'result', configurationIdentity: identity, arguments: input },
        onEffectReceipt: value => { receipt = value; },
      }, async invocation => images.capability(purpose, input as any, { owner, signal: controller.signal, invocation } as any));
      return { data: data as any, receipt: receipt! };
    } finally { release(); configuration.release?.(); }
  }
  return { images, invoke, controller, requests, stored, published, fetches, dispatched, inference, owned: () => owned, network: (value: typeof network) => { network = value; },
    setPayload(value: unknown) { payload = value; }, setAfterReceipt(value: () => void) { afterReceipt = value; },
    setDownload(value: typeof download) { download = value; }, failRetention() { retentionFailure = true; },
    select(value: unknown) { selection = value; }, endpoint(value: string) { endpoint = value; } };
}

describe('image tools use their original execution and media ownership', () => {
  test('generation and editing are independently visible; accepted configurations retain the original route', async () => {
    const f = fixture();
    const generation = IMAGE_TOOL_DECLARATIONS[0]!, editing = IMAGE_TOOL_DECLARATIONS[1]!;
    f.select({ generation: null });
    const absent = await f.images.prepareConfiguration({ source: null } as any, []);
    expect(absent.enabled!(generation)).toBe(false); expect(absent.enabled!(editing)).toBe(false);
    f.select({ editing: { providerId: 'images', modelId: 'model' } });
    const selected = await f.images.prepareConfiguration({ source: null } as any, []);
    expect(selected.enabled!(generation)).toBe(false); expect(selected.enabled!(editing)).toBe(true);
    const identity = selected(editing); const release = selected.retain!(editing, identity);
    f.endpoint('https://replacement.example/v1'); f.select({});
    const original = await f.images.prepareConfiguration({ source: null } as any, [{ serviceId: editing.id, serviceVersion: editing.version, configurationIdentity: identity }] as any);
    expect(original(editing, identity)).toBe(identity); release(); absent.release?.(); selected.release?.(); original.release?.(); expect(f.owned()).toBe(0); await f.inference.close();
  });
  test('cancellation after the provider receipt retains downloaded images and actual non-token usage', async () => {
    const f = fixture();
    f.setPayload({ id: 'response', data: [{ url: 'https://media.example/temporary' }], usage: { input_tokens: 12, output_tokens: 8, images: 1, cost: 0.03 } });
    f.setAfterReceipt(() => f.controller.abort());
    f.setDownload(async (_url, init) => { expect(init?.signal?.aborted).not.toBe(true); return new Response(png, { headers: { 'content-type': 'image/png' } }); });
    const result = await f.invoke();
    expect(result.data.status).toBe('ok'); expect(result.data.images).toHaveLength(1);
    expect(f.stored[0].provenance.operationId).toBeTruthy();
    expect(f.published[0].receipt.usage).toEqual({ measurement: 'actual', inputTokens: 12, outputTokens: 8 });
    expect(f.published[0].response.rawUsage.cost).toBe(0.03);
    expect(result.receipt.executor_stopped).toBe(true); expect(result.receipt.completion).toMatchObject({ effect: 'confirmed', content: { parts: [{ kind: 'media' }] } });
    expect(f.owned()).toBe(0); await f.inference.close();
  });
  test('failed resource retention cannot publish success or an unstable preview', async () => {
    const f = fixture(); f.failRetention(); const result = await f.invoke();
    expect(result.data.status).toBe('failed'); expect(result.data.images).toEqual([]);
    expect(result.receipt.completion).toMatchObject({ effect: 'confirmed', content: { parts: [] } });
    expect(f.published).toHaveLength(1); await f.inference.close();
  });
});

test('downloaded and embedded image resources are validated against their actual raster bytes', async () => {
  expect(imageMimeType(png)).toBe('image/png');
  await expect(resolveImageBytes({ data: Buffer.from('not an image').toString('base64'), mimeType: 'image/png' }, async () => { throw new Error('unexpected'); })).rejects.toThrow();
  await expect(resolveImageBytes({ url: 'https://media.example/image' }, async () => new Response('not an image', { headers: { 'content-type': 'image/png' } }))).rejects.toThrow();
});


test('image inference consumes the frozen channel route, nonsecret headers and egress selection', async () => {
  const f = fixture(); const proxy = { mode: 'direct' };
  f.network({ path: '/custom/render', headers: { 'x-project': 'original' }, proxy });
  const result = await f.invoke();
  expect(result.data.status).toBe('ok');
  expect(f.dispatched[0].destination).toBe('https://image.example/v1/custom/render');
  expect(f.dispatched[0].headers.get('x-project')).toBe('original');
  expect(f.dispatched[0].headers.get('authorization')).toBe('Bearer key');
  expect(f.dispatched[0].override).toEqual(proxy);
  expect(f.owned()).toBe(0); await f.inference.close();
});
