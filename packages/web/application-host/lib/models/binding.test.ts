import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelsService } from './service.js';
import { createModelAuthority } from '../kernel/model-authority.js';
import type { ModelChannel } from '@varin/application-client';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'varin-model-binding-')); roots.push(root);
  const models = new ModelsService(root, { projectTrusted: () => false });
  const reference = await models.storeCredential('test-key');
  const channel: ModelChannel = { id: 'azure', type: 'azure', name: 'Azure', enabled: true, baseUrl: 'https://first.openai.azure.com',
    authentication: { kind: 'credential', reference }, parameters: { deployment: 'first-deployment', apiVersion: '2026-01-01' },
    models: [{ id: 'logical-model', requestModelId: 'upstream-model', name: 'Model', enabled: true, operations: ['chat'] }] };
  await models.save(channel, (await models.read()).revision);
  return { models, channel, authority: createModelAuthority(models) };
}

test('chat preparation captures one channel snapshot; later connection edits cannot mix old endpoint and new deployment', async () => {
  const { models, channel, authority } = await fixture();
  const originalCapture = models.captureModel.bind(models);
  models.captureModel = async (provider, model) => {
    const captured = await originalCapture(provider, model);
    await models.save({ ...channel, baseUrl: 'https://replacement.openai.azure.com', parameters: { deployment: 'replacement' } }, (await models.read()).revision);
    return captured;
  };
  const selected = await authority.resolveModel({ providerId: channel.id, modelId: 'logical-model' });
  expect(selected.configuration.endpoint).toBe('https://first.openai.azure.com/openai/v1/responses');
  expect(selected.configuration.azureDeployment).toBe('first-deployment');
  expect(selected.configuration.azureApiVersion).toBe('2026-01-01');
  expect((await selected.credentialOwner.resolve(await selected.credentialOwner.scope())).headers['api-key']).toBe('test-key');
});

test('disabling the logical catalog model withdraws later authorization even when the upstream model ID is an alias', async () => {
  const { models, channel, authority } = await fixture();
  const selected = await authority.resolveModel({ providerId: channel.id, modelId: 'logical-model' });
  const scope = await selected.credentialOwner.scope();
  await models.save({ ...channel, models: channel.models.map(model => ({ ...model, enabled: false })) }, (await models.read()).revision);
  await expect(selected.credentialOwner.resolve(scope)).rejects.toMatchObject({ code: 'credential-resolution-failed' });
});

test('MCP bearer projection uses the same OAuth identity and refuses unsupported authorization schemes', async () => {
  const { models, channel } = await fixture();
  const reference = await models.credentials.linkOAuth({ kind: 'oauth', provider: 'openrouter', accessToken: 'oauth-token' });
  await models.save({ ...channel, authentication: { kind: 'credential', reference } }, (await models.read()).revision);
  expect(await models.mcpBearerToken(channel.id)).toBe('oauth-token');
  const original = models.getAuth;
  models.getAuth = async () => ({ auth: { headers: { authorization: 'Basic abc' } }, source: 'oauth' });
  await expect(models.mcpBearerToken(channel.id)).rejects.toMatchObject({ code: 'mcp-authentication-unsupported' });
  models.getAuth = original;
});

test('image schemas expose only declared model parameters and never infer mask capability from image input', async () => {
  const { models, channel } = await fixture();
  const image: ModelChannel = { ...channel, type: 'openai-compatible', parameters: {}, models: [{ id: 'image', name: 'Image', enabled: true, operations: ['image-generation', 'image-editing'] }] };
  await models.save(image, (await models.read()).revision);
  expect((await models.listImageModels())[0]).toMatchObject({ supportsEditing: true, supportsMask: false, parameters: [] });
  image.models[0]!.image = { mask: true, parameters: { count: { maximum: 2 }, quality: { enum: ['high', 'low'] } } };
  await models.save(image, (await models.read()).revision);
  const { imageToolContract } = await import('@varin/protocol');
  const { compileToolJsonSchema } = await import('./schema.js');
  const info = (await models.resolveImageBinding(image.id, 'image', 'editing')).imageModel!;
  const validate = compileToolJsonSchema(imageToolContract('editing', info).inputSchema);
  const input = { prompt: 'edit', images: [{ resourceId: 'existing' }], mask: { resourceId: 'mask' }, parameters: { count: 2, quality: 'high' } };
  expect(validate(input)).toBe(true);
  expect(validate({ ...input, parameters: { count: 3 } })).toBe(false);
  expect(validate({ ...input, parameters: { size: 'large' } })).toBe(false);
  expect(validate({ ...input, parameters: { count: 0 } })).toBe(false);
});


test('recovery keeps the original AWS signing region and channel headers after ordinary edits', async () => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'fixture-access'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-secret'); vi.stubEnv('AWS_PROFILE', '');
  const { models, channel, authority } = await fixture();
  const aws: ModelChannel = { ...channel, type: 'bedrock', baseUrl: 'https://proxy.example.test/aws',
    authentication: { kind: 'aws-chain' }, parameters: { region: 'us-west-2' }, connection: { headers: { 'x-project': 'original' } } };
  await models.save(aws, (await models.read()).revision);
  const original = await authority.resolveModel({ providerId: aws.id, modelId: 'logical-model' });
  const scope = await original.credentialOwner.scope();
  await models.save({ ...aws, parameters: { region: 'eu-west-1' }, connection: { headers: { 'x-project': 'replacement' } } }, (await models.read()).revision);
  const restored = await authority.rebindModel(original.configuration, scope);
  try {
    const auth = await restored.resolve(scope, undefined, { method: 'POST', endpoint: original.configuration.endpoint, payloadSha256: 'a'.repeat(64) });
    expect(auth.headers.authorization).toContain('/us-west-2/bedrock/aws4_request');
    expect(auth.headers['x-project']).toBe('original');
    expect(original.configuration.awsRegion).toBe('us-west-2');
  } finally { restored.release(); original.credentialOwner.release(); }
});
