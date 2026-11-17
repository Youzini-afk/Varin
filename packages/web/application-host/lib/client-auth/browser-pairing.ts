import crypto from 'node:crypto';

export const BROWSER_PAIRING_PATH = '/pair';
export const BROWSER_PAIRING_REDEEM_PATH = '/api/client-auth/pairing/browser/redeem';
// Browsers cap persistent cookies. This is storage retention, never an extension
// of the server-side device expiration (which remains authoritative).
const COOKIE_RETENTION_SECONDS = 400 * 24 * 60 * 60;

export const browserClientCookieName = (serverId: string): string => {
  if (!serverId.trim()) throw new Error('Browser pairing requires a stable Host identity');
  return `__Host-varin_client_${crypto.createHash('sha256').update(serverId).digest('hex').slice(0, 24)}`;
};

export function browserClientCookie(name: string, token: string, expiresAt: string | null): string {
  const remaining = expiresAt === null ? COOKIE_RETENTION_SECONDS : Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  if (!Number.isFinite(remaining)) throw new Error('Invalid browser client expiration');
  const maxAge = token ? Math.min(remaining, COOKIE_RETENTION_SECONDS) : 0;
  return `${name}=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${new Date(maxAge ? Date.now() + maxAge * 1000 : 0).toUTCString()}`;
}

export function buildBrowserPairingUrl(origin: string, pairing: { id: string; secret: string; expiresAt: string; fingerprint: string }): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Object.assign(new Error('Browser pairing requires an HTTPS origin'), { statusCode: 400 });
  }
  const payload = { v: 2, pairingId: pairing.id, secret: pairing.secret, expiresAt: pairing.expiresAt,
    fingerprint: pairing.fingerprint, candidates: [{ type: 'tunnel', url: url.origin, priority: 10 }] };
  url.pathname = BROWSER_PAIRING_PATH;
  url.hash = `pairing=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return url.toString();
}

// No URL secret is rendered into HTML, logged by the server, or fetched by a
// preview GET. Clear the fragment immediately, then require an explicit click.
const messages = {
  en: { title: 'Connect this browser', ready: 'Connect this browser to {host}?', missing: 'Open a new device pairing link from your Varin Host.', connecting: 'Connecting…', failed: 'Could not confirm pairing. Reopen your link or create a new one.', button: 'Connect', preparing: 'Preparing device pairing…', javascript: 'JavaScript is required to pair this browser.' },
  'zh-CN': { title: '连接此浏览器', ready: '将此浏览器连接到 {host}', missing: '请从 Varin 打开新的设备配对链接。', connecting: '正在连接…', failed: '未能确认配对，请重新打开链接或创建新链接。', button: '连接', preparing: '正在准备设备配对…', javascript: '请启用 JavaScript 后连接此浏览器。' },
  'zh-TW': { title: '連接此瀏覽器', ready: '將此瀏覽器連接到 {host}', missing: '請從 Varin 開啟新的裝置配對連結。', connecting: '正在連接…', failed: '未能確認配對，請重新開啟連結或建立新連結。', button: '連接', preparing: '正在準備裝置配對…', javascript: '請啟用 JavaScript 後連接此瀏覽器。' },
};
const style = `:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f5f4;color:#252526}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px}main{width:min(100%,420px)}.brand{font-size:14px;color:#737373;margin:0 0 36px}h1{font-size:24px;line-height:1.3;font-weight:600;letter-spacing:-.02em;margin:0 0 16px}p{font-size:15px;line-height:1.7;overflow-wrap:anywhere;margin:0 0 24px}button{font:inherit;border:1px solid #d4d4d4;border-radius:12px;padding:10px 24px;background:#fff;color:inherit;cursor:pointer}button:disabled{opacity:.6;cursor:wait}button:focus-visible{outline:2px solid #6b83ac;outline-offset:3px}@media(prefers-color-scheme:dark){:root{background:#202021;color:#e5e5e5}.brand{color:#a3a3a3}button{border-color:#505052;background:#303032}}`;

export function createBrowserPairingPage(acceptLanguage = 'en') {
  const preferred = acceptLanguage.split(',')[0]?.trim().toLowerCase() ?? 'en';
  const locale = /^zh-(tw|hk|hant)/.test(preferred) ? 'zh-TW' : preferred.startsWith('zh') ? 'zh-CN' : 'en';
  const text = messages[locale];
  const script = `(() => {
  const text = ${JSON.stringify(text)};
  const fragment = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  const status = document.getElementById('status');
  const button = document.getElementById('connect');
  let payload;
  try {
    const encoded = fragment.get('pairing');
    if (!encoded) throw new Error();
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    if (payload.v !== 2 || typeof payload.pairingId !== 'string' || typeof payload.secret !== 'string') throw new Error();
    status.textContent = text.ready.replace('{host}', location.host);
    button.hidden = false;
  } catch { status.textContent = text.missing; return; }
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = text.connecting;
    try {
      const response = await fetch('${BROWSER_PAIRING_REDEEM_PATH}', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingId: payload.pairingId, secret: payload.secret,
          deviceName: navigator.userAgent, devicePlatform: navigator.platform })
      });
      payload = null;
      if (!response.ok) throw new Error();
      location.replace('/');
    } catch {
      payload = null;
      status.textContent = text.failed;
    }
  });
})();`;

  return {
    contentSecurityPolicy: `default-src 'none'; script-src 'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'; style-src 'sha256-${crypto.createHash('sha256').update(style).digest('base64')}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    html: `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${text.title} · Varin</title><style>${style}</style><body><main><p class="brand">Varin</p><h1>${text.title}</h1><p id="status">${text.preparing}</p><button id="connect" hidden>${text.button}</button><noscript>${text.javascript}</noscript></main><script>${script}</script></body></html>`,
  };
}

export const browserPairingPage = createBrowserPairingPage();
