import { expect, it, vi } from 'vitest';
import { createEndpointProof } from '../platform/external-endpoint-proof.js';
import { createExternalAccessDiagnostics } from './external-access-diagnostics.js';

const entrance = (origin: string) => ({
  enabled: true, configuration: { origin, host: '127.0.0.1', port: 3100 },
  issueEndpointProof: vi.fn(createEndpointProof().issue),
});

it('checks only on demand, coalesces concurrent attempts, and keeps readiness separate', async () => {
  const active = entrance('https://varin.example.test');
  const inspect = vi.fn(async () => 'tls' as const);
  const diagnostic = createExternalAccessDiagnostics(() => active, inspect);
  expect(diagnostic.getLastCheck()).toBeUndefined();
  expect(inspect).not.toHaveBeenCalled();
  const attempt = diagnostic.check();
  expect(diagnostic.check()).toBe(attempt);
  await attempt;
  expect(active.issueEndpointProof).toHaveBeenCalledOnce();
  expect(inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ origin: active.configuration.origin }));
  expect(diagnostic.getLastCheck()).toEqual({
    origin: active.configuration.origin, checkedAt: expect.any(Number), state: 'unverified', reason: 'tls',
  });
  expect(active.enabled).toBe(true);
  active.enabled = false;
  expect(diagnostic.getLastCheck()).toBeUndefined();
  await expect(diagnostic.check()).rejects.toMatchObject({ code: 'not_enabled' });
});

it('aborts a superseded check and never publishes it for the replacement entrance', async () => {
  let active = entrance('https://old.example.test');
  let firstSignal: AbortSignal | undefined;
  let finish: (() => void) | undefined;
  const inspect = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
    if (!firstSignal) {
      firstSignal = signal;
      await new Promise<void>(resolve => { finish = resolve; });
    }
    return 'verified' as const;
  });
  const diagnostic = createExternalAccessDiagnostics(() => active, inspect);
  const old = diagnostic.check();
  await Promise.resolve();
  active = entrance('https://new.example.test');
  await diagnostic.check();
  expect(firstSignal?.aborted).toBe(true);
  finish?.();
  await old;
  expect(diagnostic.getLastCheck()).toMatchObject({ origin: active.configuration.origin, state: 'verified' });
});
