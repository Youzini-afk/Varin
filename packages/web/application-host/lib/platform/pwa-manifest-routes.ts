import type { ThreadSummary } from '@varin/protocol';

const DEFAULT_PWA_APP_NAME = 'Varin - Agent Workspace';

export interface PwaManifestRequest {
  query?: Record<string, unknown> | undefined;
}

export interface PwaManifestResponse {
  send(value: string): unknown;
  setHeader(name: string, value: string): unknown;
  type(value: string): unknown;
}

export type PwaManifestHandler = (
  request: PwaManifestRequest,
  response: PwaManifestResponse,
) => Promise<void>;

export interface PwaManifestApp {
  get(path: string, handler: PwaManifestHandler): unknown;
}

const mapPwaOrientationToManifest = (value: unknown): string | undefined => {
  if (value === 'portrait') return 'portrait-primary';
  if (value === 'landscape') return 'landscape-primary';
  return undefined;
};

interface RecentShortcut {
  description: string;
  icons: Array<{ sizes: string; src: string; type: string }>;
  name: string;
  short_name: string;
  url: string;
}

export interface PwaManifestRouteDependencies {
  listRecentThreads(): Promise<ThreadSummary[]> | ThreadSummary[];
  normalizePwaAppName(value: unknown, fallback: string): string | undefined;
  normalizePwaOrientation(value: unknown, fallback: string): string | undefined;
  readSettingsFromDisk(): Promise<Record<string, unknown>>;
}

export const registerPwaManifestRoute = (
  app: PwaManifestApp,
  dependencies: PwaManifestRouteDependencies,
): void => {
  const {
    listRecentThreads,
    readSettingsFromDisk,
    normalizePwaAppName,
    normalizePwaOrientation,
  } = dependencies;
  let recentThreadCache: { at: number; data: RecentShortcut[] } | null = null;

  const getRecentThreadShortcuts = async (): Promise<RecentShortcut[]> => {
    const now = Date.now();
    if (recentThreadCache && now - recentThreadCache.at < 5000) return recentThreadCache.data;
    try {
      const threads = await listRecentThreads();
      const rows: RecentShortcut[] = threads
        .filter(thread => !thread.bot_id && !thread.archived && thread.deleted_at_ms === null)
        .sort((left, right) => right.updated_at_ms - left.updated_at_ms)
        .slice(0, 3)
        .map((thread, index) => {
          const title = (normalizePwaAppName(thread.title, `Conversation ${index + 1}`) ?? `Conversation ${index + 1}`).slice(0, 48);
          const query = new URLSearchParams({ thread: thread.thread_id, branch: thread.main_branch_id });
          return { name: title, short_name: title.slice(0, 32), description: 'Open recent conversation',
            url: `/?${query}`, icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }] };
        });
      recentThreadCache = { at: now, data: rows };
      return rows;
    } catch {
      // A transient catalog failure must not replace the last valid shortcut projection.
      return recentThreadCache?.data ?? [];
    }
  };

  app.get('/manifest.webmanifest', async (req, res) => {
    const queryName = typeof req.query?.pwa_name === 'string'
      ? req.query.pwa_name
      : typeof req.query?.app_name === 'string'
        ? req.query.app_name
        : typeof req.query?.appName === 'string'
          ? req.query.appName
          : null;
    const queryOrientation = typeof req.query?.orientation === 'string' ? req.query.orientation : null;
    let storedName = '';
    let storedOrientation = 'system';
    try {
      const settings = await readSettingsFromDisk();
      storedName = normalizePwaAppName(settings.pwaAppName, '') ?? '';
      storedOrientation = normalizePwaOrientation(settings.pwaOrientation, 'system') ?? 'system';
    } catch {
      // Defaults keep the manifest valid when settings cannot be read.
    }

    const appName = queryName === null
      ? (storedName || DEFAULT_PWA_APP_NAME)
      : (normalizePwaAppName(queryName, '') || DEFAULT_PWA_APP_NAME);
    const orientation = mapPwaOrientationToManifest(
      queryOrientation === null
        ? storedOrientation
        : normalizePwaOrientation(queryOrientation, 'system') ?? 'system',
    );
    const shortcuts = await getRecentThreadShortcuts();
    const manifest = {
      name: appName,
      short_name: appName.slice(0, 30),
      description: 'Agent workspace and harness for coding and research',
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      display_override: ['window-controls-overlay'],
      background_color: '#151313',
      theme_color: '#edb449',
      ...(orientation ? { orientation } : {}),
      icons: [
        { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/pwa-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        { src: '/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
        { src: '/apple-touch-icon-152x152.png', sizes: '152x152', type: 'image/png', purpose: 'any' },
        { src: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
        { src: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
      ],
      shortcuts: [
        {
          name: 'Appearance Settings',
          short_name: 'Settings',
          description: 'Open appearance settings',
          url: '/?settings=appearance',
          icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
        },
        ...shortcuts,
      ],
      categories: ['developer', 'tools', 'productivity'],
      lang: 'en',
    };
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.type('application/manifest+json');
    res.send(JSON.stringify(manifest));
  });
};
