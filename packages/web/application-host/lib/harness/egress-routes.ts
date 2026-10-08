import type { Express, RequestHandler } from 'express';
import express from 'express';
import type { EgressRuntime } from './egress.js';
import { EGRESS_TIMEOUT, EgressError } from './egress.js';
import {
  encodeOutboundProxyAuth, OUTBOUND_PROXY_CREDENTIAL_REF, outboundProxyBinding, readOutboundProxyAuth,
} from './egress-settings.js';

export function registerEgressRoutes(app: Express, options: {
  requireAuth: RequestHandler;
  readSettings(): Promise<Record<string, unknown>>;
  readAuth(): Record<string, unknown>;
  saveAuth(ref: string, entry: { key: string }): unknown | Promise<unknown>;
  removeAuth(ref: string): boolean | Promise<boolean>;
  egress: EgressRuntime;
}): void {
  const { requireAuth, readSettings, readAuth, saveAuth, removeAuth, egress } = options;
  app.get('/api/harness/egress/credentials', requireAuth, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const binding = outboundProxyBinding(await readSettings());
      return res.json({ configured: binding ? readOutboundProxyAuth(readAuth(), binding.credentialRef, binding.proxyOrigin) !== undefined : false });
    } catch { return res.status(500).json({ error: 'Unable to read proxy credential status' }); }
  });
  app.put('/api/harness/egress/credentials', requireAuth, express.json({ limit: '16kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { username, password, credentialRef } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Proxy username and password are required' });
    }
    try {
      const binding = outboundProxyBinding(await readSettings());
      if (!binding || binding.credentialRef !== credentialRef) {
        return res.status(409).json({ error: 'Proxy settings changed; reload before saving credentials' });
      }
      await saveAuth(OUTBOUND_PROXY_CREDENTIAL_REF, { key: encodeOutboundProxyAuth(binding.credentialRef, binding.proxyOrigin, username, password) });
      return res.json({ configured: true });
    } catch { return res.status(500).json({ error: 'Unable to save proxy credential' }); }
  });
  app.delete('/api/harness/egress/credentials', requireAuth, express.json({ limit: '16kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const binding = outboundProxyBinding(await readSettings());
      if (!binding || binding.credentialRef !== req.body?.credentialRef) {
        return res.status(409).json({ error: 'Proxy settings changed; reload before removing credentials' });
      }
      await removeAuth(OUTBOUND_PROXY_CREDENTIAL_REF);
      return res.json({ configured: false });
    }
    catch { return res.status(500).json({ error: 'Unable to remove proxy credential' }); }
  });
  app.post('/api/harness/egress/verify', requireAuth, express.json({ limit: '16kb' }), async (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url : '';
    if (!url) return res.status(400).json({ ok: false, error: 'An HTTP(S) URL is required' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(EGRESS_TIMEOUT), 20_000);
    try {
      const outbound = await egress.prepare(url);
      const response = await outbound.fetch(url, { signal: controller.signal });
      await response.body?.cancel();
      return res.json({ ok: response.ok, status: response.status, policy: {
        mode: outbound.policy.mode, source: outbound.policy.source,
        ...(outbound.policy.proxyOrigin ? { proxyOrigin: outbound.policy.proxyOrigin } : {}),
      } });
    } catch (error) {
      const failure = error instanceof EgressError ? error : null;
      return res.json({ ok: false, errorClass: controller.signal.reason === EGRESS_TIMEOUT ? 'timeout' : failure?.kind ?? 'unknown',
        error: controller.signal.reason === EGRESS_TIMEOUT ? 'request timed out' : failure?.message ?? 'connection failed' });
    } finally { clearTimeout(timer); }
  });
}
