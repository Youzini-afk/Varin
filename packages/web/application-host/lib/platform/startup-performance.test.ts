import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordStartupPerformance } from './startup-performance.js';

const loggedEvent = (info: ReturnType<typeof vi.spyOn>, index = 0): Record<string, unknown> => {
  const value = info.mock.calls[index]?.[1];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected startup performance event');
  }
  return value as Record<string, unknown>;
};

describe('startup performance diagnostics', () => {
  const previousValue = process.env.VARIN_STARTUP_PERF;

  afterEach(() => {
    if (previousValue === undefined) delete process.env.VARIN_STARTUP_PERF;
    else process.env.VARIN_STARTUP_PERF = previousValue;
    vi.restoreAllMocks();
  });

  it('is disabled by default', () => {
    delete process.env.VARIN_STARTUP_PERF;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    recordStartupPerformance('web.listener.ready', { durationMs: 5 });

    expect(info).not.toHaveBeenCalled();
  });

  it('records only approved labels and numeric metadata', () => {
    process.env.VARIN_STARTUP_PERF = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    recordStartupPerformance('web.listener.ready', {
      durationMs: 75,
      totalDurationMs: 100,
      attempt: 1,
      outcome: 'ready',
      routeClass: 'thread-messages',
      sessionID: 'secret-session',
      directory: '/secret/directory',
      token: 'secret-token',
    });

    expect(info).toHaveBeenCalledOnce();
    const event = loggedEvent(info);
    expect(event).toMatchObject({
      phase: 'web.listener.ready',
      durationMs: 75,
      totalDurationMs: 100,
      attempt: 1,
      outcome: 'ready',
      routeClass: 'thread-messages',
    });
    expect(Number.isFinite(event.at)).toBe(true);
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('rejects unknown phases and invalid field values', () => {
    process.env.VARIN_STARTUP_PERF = 'true';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    recordStartupPerformance('secret.phase', { durationMs: 1 });
    recordStartupPerformance('web.pipeline.start', {
      durationMs: -1,
      attempt: 1.5,
      outcome: 'secret-outcome',
      routeClass: 'secret-route',
    });

    expect(info).toHaveBeenCalledOnce();
    const event = loggedEvent(info);
    expect(event).toEqual(expect.objectContaining({
      phase: 'web.pipeline.start',
    }));
    expect(event).not.toHaveProperty('durationMs');
    expect(event).not.toHaveProperty('attempt');
    expect(event).not.toHaveProperty('outcome');
    expect(event).not.toHaveProperty('routeClass');
  });
});
