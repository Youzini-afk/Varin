import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HostEventData } from '@varin/protocol';
import { SessionHost } from '../src/session-host.js';
import { McpAuthority } from '../src/mcp-authority.js';

it('Pi MCP owner startup does not require a harness request before the session can be broker-bound', { timeout: 15_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-mcp-startup-review-'));
  const agentDir = path.join(root, 'agent'); await fs.mkdir(agentDir);
  const authority = new McpAuthority();
  const observations: Array<{ beforeCreateReturned: boolean; beforeSnapshot: boolean; sessionId?: string; settingsAvailable: boolean }> = [];
  let created = false; let snapshotSeen = false;
  const host = new SessionHost({ agentDir, projectTrustOverride: true, emit: (event, data) => {
    if (event === 'session.snapshot') snapshotSeen = true;
    if (event !== 'harness.request') return;
    const request = data as HostEventData<'harness.request'>;
    if (request.method !== 'mcp.owner') {
      queueMicrotask(() => host.respondHarness(host.sessionId ?? '', request.requestId, { ok: false, error: { code: 'unavailable', message: 'unneeded startup fixture service' } })); return;
    }
    const params = request.params as { operation: string; scope?: string };
    if (params.operation === 'open') {
      const observation = { beforeCreateReturned: !created, beforeSnapshot: !snapshotSeen, ...(host.sessionId ? { sessionId: host.sessionId } : {}), settingsAvailable: false };
      observations.push(observation);
      void host.getSettings().then(settings => {
        observation.settingsAvailable = true;
        const opened = authority.open({ agentDir, configCwd: root, executionCwd: root, environmentId: 'startup-fixture', executionScope: 'workspace', projectTrusted: settings.projectTrusted, sessionId: host.sessionId ?? 'unbound' });
        host.respondHarness(host.sessionId ?? '', request.requestId, { ok: true, result: opened });
      }, error => host.respondHarness(host.sessionId ?? '', request.requestId, { ok: false, error: { code: 'failed', message: String(error) } }));
    } else if (params.operation === 'close') {
      if (params.scope) authority.closeScope(params.scope);
      queueMicrotask(() => host.respondHarness(host.sessionId ?? '', request.requestId, { ok: true, result: {} }));
    }
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([host.create(root).then(() => { created = true; }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`startup did not complete: ${JSON.stringify(observations)}`)), 8_000); })]);
    assert.equal(observations.filter(value => value.beforeCreateReturned).length, 0, `MCP requested an unbound broker actor: ${JSON.stringify(observations)}`);
    const catalog = await host.mcpConfigSnapshot();
    assert.equal(catalog.catalog?.version, 1, JSON.stringify(catalog));
    assert.ok(observations.length > 0, 'post-bind MCP configuration must still reach the Host owner');
    assert.ok(observations.every(value => !value.beforeCreateReturned && !value.beforeSnapshot && value.settingsAvailable));
  } finally { if (timer) clearTimeout(timer); await host.dispose(); await authority.close(); await fs.rm(root, { recursive: true, force: true }); }
});
