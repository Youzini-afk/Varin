import type { Express, Request, Response } from 'express';
import type { createApnsRuntime } from './apns-runtime.js';
import type { createPushRuntime } from './push-runtime.js';

interface PushSubscribeBody {
  endpoint: string;
  keys: { auth: string; p256dh: string };
}

interface NotificationRouteDependencies
  extends Pick<ReturnType<typeof createPushRuntime>,
    | 'addOrUpdatePushSubscription'
    | 'ensurePushInitialized'
    | 'getOrCreateVapidKeys'
    | 'isUiVisible'
    | 'removePushSubscription'
    | 'setPushInitialized'
    | 'updateUiVisibility'>,
  Pick<ReturnType<typeof createApnsRuntime>, 'addOrUpdateApnsToken' | 'removeApnsToken'> {
  clearPendingPushBadge?: () => void;
  getUiNotificationClients: () => Set<Response>;
  getUiSessionTokenFromRequest: (req: Request) => string | null;
  readSettingsFromDisk: () => Promise<Record<string, unknown>>;
  uiAuthController?: {
    ensureSessionToken(req: Request, res: Response): Promise<string | null>;
  };
  updateSettingsOnDisk: (
    mutate: (settings: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  writeSseEvent: (res: Response, event: { properties: Record<string, unknown>; type: string }) => void;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const parsePushSubscribeBody = (body: unknown): PushSubscribeBody | null => {
  const record = asRecord(body);
  if (!record) return null;
  const endpoint = record.endpoint;
  const keys = asRecord(record.keys);
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;

  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) return null;
  if (typeof p256dh !== 'string' || p256dh.trim().length === 0) return null;
  if (typeof auth !== 'string' || auth.trim().length === 0) return null;

  return {
    endpoint: endpoint.trim(),
    keys: { p256dh: p256dh.trim(), auth: auth.trim() },
  };
};

const parsePushUnsubscribeBody = (body: unknown): { endpoint: string } | null => {
  const endpoint = asRecord(body)?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) return null;
  return { endpoint: endpoint.trim() };
};

export const NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS = 20_000;

export interface NotificationStreamRouteDependencies {
  getUiNotificationClients: () => Set<Response>;
  getUiSessionTokenFromRequest: (req: Request) => string | null;
  uiAuthController?: {
    ensureSessionToken(req: Request, res: Response): Promise<string | null>;
  };
  writeSseEvent: (res: Response, event: { properties: Record<string, unknown>; type: string }) => void;
}

export const registerNotificationStreamRoute = (
  app: Express,
  {
    getUiNotificationClients,
    getUiSessionTokenFromRequest,
    uiAuthController,
    writeSseEvent,
  }: NotificationStreamRouteDependencies,
): void => {
  app.get('/api/notifications/stream', async (req, res) => {
    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) return;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const clients = getUiNotificationClients();
    clients.add(res);
    let closed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      clients.delete(res);
    };
    req.on('close', cleanup);
    res.on('error', cleanup);

    const flushSse = (): void => {
      (res as Response & { flush?: () => void }).flush?.();
    };
    heartbeatTimer = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) return cleanup();
      try {
        res.write(':heartbeat\n\n');
        flushSse();
      } catch {
        cleanup();
      }
    }, NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);

    try {
      writeSseEvent(res, {
        type: 'varin:notification-stream-ready',
        properties: { uiToken },
      });
      flushSse();
    } catch {
      cleanup();
    }
  });
};

export const registerNotificationRoutes = (app: Express, dependencies: NotificationRouteDependencies): void => {
  const {
    uiAuthController,
    ensurePushInitialized,
    getOrCreateVapidKeys,
    getUiSessionTokenFromRequest,
    readSettingsFromDisk,
    updateSettingsOnDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    addOrUpdateApnsToken,
    removeApnsToken,
    updateUiVisibility,
    isUiVisible,
    getUiNotificationClients,
    writeSseEvent,
    setPushInitialized,
  } = dependencies;

  app.get('/api/push/vapid-public-key', async (_req, res) => {
    try {
      await ensurePushInitialized();
      const keys = await getOrCreateVapidKeys();
      res.json({ publicKey: keys.publicKey });
    } catch (error) {
      console.warn('[Push] Failed to load VAPID key:', error);
      res.status(500).json({ error: 'Failed to load push key' });
    }
  });

  app.post('/api/push/subscribe', async (req, res) => {
    await ensurePushInitialized();

    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const parsed = parsePushSubscribeBody(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    const { endpoint, keys } = parsed;

    const origin = typeof req.body?.origin === 'string' ? req.body.origin.trim() : '';
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      try {
        const settings = await readSettingsFromDisk();
        if (typeof settings?.publicOrigin !== 'string' || settings.publicOrigin.trim().length === 0) {
          await updateSettingsOnDisk((current) => (
            typeof current?.publicOrigin === 'string' && current.publicOrigin.trim().length > 0
              ? current
              : { ...current, publicOrigin: origin }
          ));
          setPushInitialized(false);
        }
      } catch {
        // Origin persistence is opportunistic; subscription registration still succeeds.
      }
    }

    const platform = typeof req.body?.platform === 'string' ? req.body.platform : undefined;
    await addOrUpdatePushSubscription(
      uiToken,
      {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      req.headers['user-agent'],
      platform
    );

    return res.json({ ok: true });
  });

  app.delete('/api/push/subscribe', async (req, res) => {
    await ensurePushInitialized();

    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const parsed = parsePushUnsubscribeBody(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    await removePushSubscription(uiToken, parsed.endpoint);
    return res.json({ ok: true });
  });

  // Native iOS APNs device token registration (mirrors /api/push/subscribe). The token
  // is a hex APNs device token from @capacitor/push-notifications, scoped to the UI
  // session like web-push subscriptions.
  app.post('/api/push/apns-token', async (req, res) => {

    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const deviceToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!deviceToken) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    const platform = req.body?.platform === 'android' ? 'android' : 'ios';
    // APNs environment the token belongs to: Xcode/dev-signed installs report 'sandbox',
    // TestFlight/App Store report 'production'. Absent (older clients, Android) → production.
    const environment = req.body?.environment === 'sandbox' ? 'sandbox' : 'production';
    if (typeof addOrUpdateApnsToken === 'function') {
      await addOrUpdateApnsToken(uiToken, deviceToken, req.headers['user-agent'], platform, environment, typeof req.body?.hostKey === 'string' ? req.body.hostKey : undefined);
    }
    return res.json({ ok: true });
  });

  app.delete('/api/push/apns-token', async (req, res) => {
    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const deviceToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!deviceToken) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    if (typeof removeApnsToken === 'function') {
      await removeApnsToken(uiToken, deviceToken);
    }
    return res.json({ ok: true });
  });

  app.post('/api/push/visibility', async (req, res) => {
    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const body = asRecord(req.body) ?? {};
    const platform = typeof body.platform === 'string' ? body.platform : undefined;
    updateUiVisibility(uiToken, body.visible === true, platform);
    return res.json({ ok: true });
  });

  app.get('/api/push/visibility', (req, res) => {
    const uiToken = getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    return res.json({
      ok: true,
      visible: isUiVisible(uiToken),
    });
  });

  registerNotificationStreamRoute(app, {
    getUiNotificationClients,
    getUiSessionTokenFromRequest,
    writeSseEvent,
    ...(uiAuthController ? { uiAuthController } : {}),
  });

};
