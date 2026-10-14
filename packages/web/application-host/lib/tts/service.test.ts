import { afterEach, expect, it, vi } from 'vitest';
const captured = vi.hoisted(() => ({ clients: [] as Array<{ apiKey: string; baseURL?: string }>, speech: vi.fn() }));
vi.mock('openai', () => ({ default: class {
  audio = { speech: { create: captured.speech } };
  constructor(options: { apiKey: string; baseURL?: string }) { captured.clients.push(options); }
} }));
import { TTSService } from './service.js';
afterEach(() => { vi.unstubAllEnvs(); captured.clients.length = 0; captured.speech.mockReset(); });

it('loads speech without a conversation account and forgets a removed Host key', () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('PI_CODING_AGENT_DIR', '/not-a-conversation-account');
  const service = new TTSService();
  expect(service.isAvailable()).toBe(false);
  vi.stubEnv('OPENAI_API_KEY', 'speech-fixture-key');
  expect(service.isAvailable()).toBe(true);
  expect(captured.clients).toEqual([{ apiKey: 'speech-fixture-key' }]);
  vi.stubEnv('OPENAI_API_KEY', '');
  expect(service.isAvailable()).toBe(false);
});

it('uses an explicit speech endpoint and credential without a Host key', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  captured.speech.mockResolvedValue(new Response('audio'));
  const service = new TTSService();
  const buffer = await service.generateSpeechBuffer({ text: 'Read this', apiKey: 'explicit-fixture-key', baseURL: 'http://localhost:8880/v1' });
  expect(buffer.toString()).toBe('audio');
  expect(captured.clients).toEqual([{ apiKey: 'explicit-fixture-key', baseURL: 'http://localhost:8880/v1' }]);
  expect(captured.speech).toHaveBeenCalledWith(expect.objectContaining({ input: 'Read this' }));
  expect(service.isAvailable()).toBe(false);
});
