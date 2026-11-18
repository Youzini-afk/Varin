import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** A renderer asset origin, never an Application Host. Window-specific
 * credentials belong to the trusted preload, not HTML shared by all windows. */
export async function servePackagedUi(
  request: Request, root: string, fetchFile: (url: string) => Promise<Response>,
  resolveArtwork: (name: string) => Promise<string | null>,
): Promise<Response> {
  const missing = () => new Response(null, { status: 404 });
  let pathname: string;
  try {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return missing();
    pathname = decodeURIComponent(url.pathname);
  } catch { return missing(); }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  if (/^\/(?:api|auth|health)(?:\/|$)/u.test(pathname)) return missing();
  if (pathname.startsWith('/companion-assets/')) {
    const artwork = await resolveArtwork(pathname.slice('/companion-assets/'.length));
    if (!artwork) return missing();
    const response = await fetchFile(pathToFileURL(artwork).toString());
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  }
  const candidate = path.join(root, pathname === '/' ? 'index.html' : pathname);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return missing();
  let file = candidate;
  try {
    if (!(await fs.stat(file)).isFile()) return missing();
  } catch {
    // Only document navigation may use the SPA history fallback. A missing JS
    // chunk or offline API request must not succeed with an HTML document.
    if (request.mode !== 'navigate' && !request.headers.get('accept')?.includes('text/html')) return missing();
    file = path.join(root, 'index.html');
  }
  if (file.endsWith('.html')) {
    return new Response(request.method === 'HEAD' ? null : await fs.readFile(file, 'utf8'),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  const response = await fetchFile(pathToFileURL(file).toString());
  return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
