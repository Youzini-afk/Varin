import { createSettingsFileStore } from '@varin/settings-store';
import type { SettingsFileStore } from '@varin/settings-store';

const PUSH_SUBSCRIPTIONS_VERSION = 1;
const UI_VISIBILITY_TTL_MS = 30_000;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

interface PushSubscriptionRecord {
  auth: string;
  createdAt: number | null;
  endpoint: string;
  p256dh: string;
  platform?: string | undefined;
}

interface PushSubscriptionInput {
  auth: string;
  endpoint: string;
  p256dh: string;
}

interface PushSubscriptionStore extends Record<string, unknown> {
  subscriptionsBySession: Record<string, unknown>;
  version: number;
}

interface WebPushLike {
  generateVAPIDKeys(): { privateKey: string; publicKey: string };
  sendNotification(subscription: {
    endpoint: string;
    keys: { auth: string; p256dh: string };
  }, payload: string): Promise<unknown>;
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
}

interface PushRuntimeDependencies {
  PUSH_SUBSCRIPTIONS_FILE_PATH: string;
  pushSubscriptionsStore?: Pick<SettingsFileStore, 'read' | 'update'>;
  readSettingsFromDisk: () => Promise<Record<string, unknown>>;
  updateSettingsOnDisk: (
    mutate: (settings: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  webPush?: WebPushLike;
}

interface VisibilityState {
  platform?: string | undefined;
  updatedAt: number;
  visible: boolean;
}

const isLoopbackHttpOrigin = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }

  return value.startsWith('http://localhost')
    || value.startsWith('http://127.0.0.1')
    || value.startsWith('http://[::1]');
};

export const createPushRuntime = (deps: PushRuntimeDependencies) => {
  const {
    PUSH_SUBSCRIPTIONS_FILE_PATH,
    readSettingsFromDisk,
    updateSettingsOnDisk,
  } = deps;
  const loadWebPush = async (): Promise<WebPushLike> => deps.webPush ?? (await import('web-push')).default;

  const emptyPushSubscriptions = (): PushSubscriptionStore => ({
    version: PUSH_SUBSCRIPTIONS_VERSION,
    subscriptionsBySession: {},
  });
  const pushSubscriptionsStore = deps.pushSubscriptionsStore ?? createSettingsFileStore({
    filePath: PUSH_SUBSCRIPTIONS_FILE_PATH,
    defaultValue: emptyPushSubscriptions(),
  });
  let pushInitialized = false;

  const uiVisibilityByToken = new Map<string, VisibilityState>();
  const pruneUiVisibility = (now = Date.now()): void => {
    for (const [token, state] of uiVisibilityByToken) {
      if (!state || now - state.updatedAt > UI_VISIBILITY_TTL_MS) {
        uiVisibilityByToken.delete(token);
      }
    }
  };

  const readPushSubscriptionsFromDisk = async (): Promise<PushSubscriptionStore> => {
    try {
      const parsed = await pushSubscriptionsStore.read();
      if (!isRecord(parsed)) {
        throw new Error('Push subscriptions file is malformed');
      }
      if (typeof parsed.version !== 'number' || parsed.version !== PUSH_SUBSCRIPTIONS_VERSION) {
        throw new Error(`Unsupported push subscriptions version: ${String(parsed.version)}`);
      }

      if (!isRecord(parsed.subscriptionsBySession)) {
        throw new Error('Push subscriptions file has invalid subscriptionsBySession');
      }

      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: parsed.subscriptionsBySession };
    } catch (error) {
      console.warn('Failed to read push subscriptions file:', error);
      throw error;
    }
  };

  const persistPushSubscriptionUpdate = async (
    mutate: (current: PushSubscriptionStore) => PushSubscriptionStore,
  ): Promise<Record<string, unknown>> => {
    return pushSubscriptionsStore.update((stored) => {
      if (stored.version !== PUSH_SUBSCRIPTIONS_VERSION) {
        throw new Error(`Unsupported push subscriptions version: ${String(stored.version)}`);
      }
      if (!isRecord(stored.subscriptionsBySession)) {
        throw new Error('Push subscriptions file has invalid subscriptionsBySession');
      }
      const next = mutate({
        version: PUSH_SUBSCRIPTIONS_VERSION,
        subscriptionsBySession: stored.subscriptionsBySession,
      });
      return next;
    });
  };

  const getOrCreateVapidKeys = async () => {
    const settings = await readSettingsFromDisk();
    const existing = isRecord(settings.vapidKeys) ? settings.vapidKeys : null;
    if (existing && typeof existing.publicKey === 'string' && typeof existing.privateKey === 'string') {
      return { publicKey: existing.publicKey, privateKey: existing.privateKey };
    }

    const generated = (await loadWebPush()).generateVAPIDKeys();
    const updated = await updateSettingsOnDisk((current) => {
      const currentKeys = isRecord(current.vapidKeys) ? current.vapidKeys : null;
      if (currentKeys && typeof currentKeys.publicKey === 'string' && typeof currentKeys.privateKey === 'string') {
        return current;
      }
      return {
        ...current,
        vapidKeys: {
          publicKey: generated.publicKey,
          privateKey: generated.privateKey,
        },
      };
    });
    const keys = isRecord(updated.vapidKeys) ? updated.vapidKeys : null;
    if (!keys || typeof keys.publicKey !== 'string' || typeof keys.privateKey !== 'string') {
      throw new Error('VAPID key persistence returned an invalid keypair');
    }
    return { publicKey: keys.publicKey, privateKey: keys.privateKey };
  };

  const normalizePushSubscriptions = (record: unknown): PushSubscriptionRecord[] => {
    if (!Array.isArray(record)) return [];
    return record
      .map((value): PushSubscriptionRecord | null => {
        const entry = isRecord(value) ? value : null;
        if (!entry) return null;
        const endpoint = entry.endpoint;
        const p256dh = entry.p256dh;
        const auth = entry.auth;
        if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
          return null;
        }
        return {
          endpoint,
          p256dh,
          auth,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
          platform: typeof entry.platform === 'string' ? entry.platform : undefined,
        };
      })
      .filter((entry): entry is PushSubscriptionRecord => Boolean(entry));
  };

  const addOrUpdatePushSubscription = async (
    uiSessionToken: string,
    subscription: PushSubscriptionInput,
    userAgent?: string,
    platform?: string,
  ): Promise<void> => {
    if (!uiSessionToken) {
      return;
    }

    await ensurePushInitialized();

    const now = Date.now();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const existing = Array.isArray(subsBySession[uiSessionToken]) ? subsBySession[uiSessionToken] : [];

      const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== subscription.endpoint);

      const previous = existing.find((entry) => entry && entry.endpoint === subscription.endpoint);
      filtered.unshift({
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        createdAt: now,
        lastSeenAt: now,
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
        // Platform lets the sender route mobile PWA push through the same presence gate as APNs.
        platform:
          typeof platform === 'string' && platform
            ? platform
            : typeof previous?.platform === 'string'
              ? previous.platform
              : undefined,
      });

      subsBySession[uiSessionToken] = filtered.slice(0, 10);

      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushSubscription = async (uiSessionToken: string, endpoint: string): Promise<void> => {
    if (!uiSessionToken || !endpoint) return;

    await ensurePushInitialized();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const existing = Array.isArray(subsBySession[uiSessionToken]) ? subsBySession[uiSessionToken] : [];
      const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
      if (filtered.length === 0) {
        delete subsBySession[uiSessionToken];
      } else {
        subsBySession[uiSessionToken] = filtered;
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushSubscriptionFromAllSessions = async (endpoint: string): Promise<void> => {
    if (!endpoint) return;

    await ensurePushInitialized();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      for (const [token, entries] of Object.entries(subsBySession)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
        if (filtered.length === 0) {
          delete subsBySession[token];
        } else {
          subsBySession[token] = filtered;
        }
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const sendPushToSubscription = async (sub: PushSubscriptionRecord, payload: unknown): Promise<void> => {
    await ensurePushInitialized();
    const body = JSON.stringify(payload);

    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    };

    try {
      await (await loadWebPush()).sendNotification(pushSubscription, body);
    } catch (error) {
      const statusCode = isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : null;
      if (statusCode === 410 || statusCode === 404) {
        await removePushSubscriptionFromAllSessions(sub.endpoint);
        return;
      }
      console.warn('[Push] Failed to send notification:', error);
    }
  };

  const sendPushToAllUiSessions = async (payload: unknown, options: { requireNoSse?: boolean } = {}): Promise<void> => {
    const requireNoSse = options.requireNoSse === true;
    const store = await readPushSubscriptionsFromDisk();
    const sessions = store.subscriptionsBySession || {};
    const subscriptionsByEndpoint = new Map<string, PushSubscriptionRecord>();

    for (const record of Object.values(sessions)) {
      const subscriptions = normalizePushSubscriptions(record);
      if (subscriptions.length === 0) continue;

      for (const sub of subscriptions) {
        if (!subscriptionsByEndpoint.has(sub.endpoint)) {
          subscriptionsByEndpoint.set(sub.endpoint, sub);
        }
      }
    }

    await Promise.all(Array.from(subscriptionsByEndpoint.values()).map(async (sub) => {
      if (requireNoSse) {
        // Mobile PWA subscriptions follow the same presence model as native push: suppress only
        // when an interactive (desktop/web) client is visible. The phone PWA's own foreground is
        // handled in the service worker (focused-client check), so it won't double-notify.
        // Non-mobile (desktop/web) subscriptions keep the existing any-visible gate.
        const suppressed = isMobilePlatform(sub.platform) ? isAnyInteractiveClientVisible() : isAnyUiVisible();
        if (suppressed) return;
      }
      await sendPushToSubscription(sub, payload);
    }));
  };

  // A client is "mobile" if it reports a native mobile platform. Anything else (web, desktop,
  // or an older client that doesn't report a platform) is treated as interactive — i.e.
  // a surface where the user would actually see the in-app notification.
  const MOBILE_PLATFORMS = new Set(['ios', 'android']);
  const isMobilePlatform = (platform: unknown): boolean => typeof platform === 'string' && MOBILE_PLATFORMS.has(platform);

  const updateUiVisibility = (token: string, visible: unknown, platform?: string): void => {
    if (!token) return;
    const now = Date.now();
    const nextVisible = Boolean(visible);
    const existing = uiVisibilityByToken.get(token);
    // Keep the last known platform if this beacon didn't carry one (e.g. a heartbeat).
    const nextPlatform = typeof platform === 'string' && platform ? platform : existing?.platform;
    uiVisibilityByToken.set(token, { visible: nextVisible, updatedAt: now, platform: nextPlatform });
  };

  const isAnyUiVisible = (): boolean => {
    const now = Date.now();
    pruneUiVisibility(now);
    for (const state of uiVisibilityByToken.values()) {
      if (state.visible === true && now - state.updatedAt <= UI_VISIBILITY_TTL_MS) {
        return true;
      }
    }
    return false;
  };

  // True when at least one NON-mobile client (desktop/web) is currently visible. Used to
  // suppress native push to the phone: an active desktop already shows the notification, so the
  // phone doesn't need it. Deliberately based on the desktop's visibility (reliable), never the
  // phone's own (a backgrounded WKWebView can't report "hidden" before iOS suspends it).
  const isAnyInteractiveClientVisible = (): boolean => {
    const now = Date.now();
    pruneUiVisibility(now);
    for (const state of uiVisibilityByToken.values()) {
      if (
        state.visible === true &&
        now - state.updatedAt <= UI_VISIBILITY_TTL_MS &&
        !isMobilePlatform(state.platform)
      ) {
        return true;
      }
    }
    return false;
  };

  const isUiVisible = (token: string): boolean => {
    const now = Date.now();
    pruneUiVisibility(now);
    const state = uiVisibilityByToken.get(token);
    return state?.visible === true && now - state.updatedAt <= UI_VISIBILITY_TTL_MS;
  };

  const resolveVapidSubject = async (): Promise<string> => {
    const configured = process.env.VARIN_VAPID_SUBJECT;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured.trim();
    }

    const originEnv = process.env.VARIN_PUBLIC_ORIGIN;
    if (typeof originEnv === 'string' && originEnv.trim().length > 0) {
      const trimmed = originEnv.trim();
      if (isLoopbackHttpOrigin(trimmed)) {
        return 'mailto:varin@localhost';
      }
      return trimmed;
    }

    try {
      const settings = await readSettingsFromDisk();
      const stored = settings?.publicOrigin;
      if (typeof stored === 'string' && stored.trim().length > 0) {
        const trimmed = stored.trim();
        if (isLoopbackHttpOrigin(trimmed)) {
          return 'mailto:varin@localhost';
        }
        return trimmed;
      }
    } catch {
      // Settings are optional; fall back to the local mailto subject.
    }

    return 'mailto:varin@localhost';
  };

  const ensurePushInitialized = async (): Promise<void> => {
    if (pushInitialized) return;
    const keys = await getOrCreateVapidKeys();
    const subject = await resolveVapidSubject();

    if (subject === 'mailto:varin@localhost') {
      console.warn('[Push] No public origin configured for VAPID; set VARIN_VAPID_SUBJECT or enable push once from a real origin.');
    }

    (await loadWebPush()).setVapidDetails(subject, keys.publicKey, keys.privateKey);
    pushInitialized = true;
  };

  const setPushInitialized = (value: unknown): void => {
    pushInitialized = value === true;
  };

  return {
    getOrCreateVapidKeys,
    addOrUpdatePushSubscription,
    removePushSubscription,
    sendPushToAllUiSessions,
    updateUiVisibility,
    isAnyUiVisible,
    isAnyInteractiveClientVisible,
    isUiVisible,
    ensurePushInitialized,
    setPushInitialized,
  };
};
