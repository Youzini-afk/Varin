import { expect, test, vi } from 'vitest';
import { checkLocalNativeRuntime } from './nativeRuntimeReadiness';

test('checks the actual local native catalog independently of the active remote Host', async () => {
  const request = vi.fn(async () => new Response('[]'));
  await checkLocalNativeRuntime('http://127.0.0.1:4321/', 'local-token', request);
  expect(request).toHaveBeenCalledWith('http://127.0.0.1:4321/api/threads/list', expect.objectContaining({
    method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-token' },
  }));
});
test('missing local Host never falls back to an active remote endpoint', async () => {
  const request = vi.fn();
  await expect(checkLocalNativeRuntime(null, '', request)).rejects.toThrow('local Application Host');
  expect(request).not.toHaveBeenCalled();
});
test('only an actual successful native catalog is ready', async () => {
  await expect(checkLocalNativeRuntime('http://localhost', '', async () => new Response('{}'))).rejects.toThrow('native Thread catalog');
  await expect(checkLocalNativeRuntime('http://localhost', '', async () => new Response('unavailable', { status: 503 }))).rejects.toThrow('503');
});
