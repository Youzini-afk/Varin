import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

const releases = new Map();
export const temporaryDownloadFailure = error =>
  [408, 429, 500, 502, 503, 504].includes(error.status ?? error.response?.statusCode)
  || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error.cause?.code ?? error.code);

// GitHub's /releases/download redirect can fail while the official release API
// and asset storage remain available. Both routes retrieve the same asset; the
// caller remains responsible for its pinned checksum. No third-party mirror.
export async function fetchBuildAsset(url, { request = fetch, token = process.env.GITHUB_TOKEN, releaseCache = releases, signal } = {}) {
  let response, failure;
  try {
    response = await request(url, signal ? { signal } : undefined);
    if (response.ok || !temporaryDownloadFailure({ status: response.status })) return response;
    failure = Object.assign(new Error(`Build asset download failed (${response.status})`), { status: response.status });
  } catch (error) {
    if (!temporaryDownloadFailure(error)) throw error;
    failure = error;
  }
  const target = new URL(response?.url || url);
  const match = target.hostname === 'github.com'
    && /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(target.pathname);
  if (!match) {
    if (response) return response;
    throw failure;
  }
  await response?.body?.cancel();
  const [, owner, repo, tag, filename] = match;
  const api = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
  const headers = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (!releaseCache.has(api)) {
    const release = request(api, { headers, ...(signal ? { signal } : {}) }).then(async result => {
      if (!result.ok) throw Object.assign(new Error(`GitHub release lookup failed (${result.status})`), { status: result.status });
      return result.json();
    }).catch(error => { releaseCache.delete(api); throw error; });
    releaseCache.set(api, release);
  }
  const release = await releaseCache.get(api);
  const asset = release.assets?.find(item => item.name === decodeURIComponent(filename));
  if (!Number.isSafeInteger(asset?.id)) throw new Error(`Release asset not found: ${owner}/${repo}/${decodeURIComponent(tag)}/${decodeURIComponent(filename)}`);
  console.log(`[build-download] Using official GitHub asset API for ${owner}/${repo}/${decodeURIComponent(filename)}`);
  // Handle the API redirect explicitly: the token never leaves api.github.com.
  const download = await request(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`, {
    headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'manual', ...(signal ? { signal } : {}),
  });
  if (download.status >= 300 && download.status < 400 && download.headers.get('location')) {
    await download.body?.cancel();
    return request(download.headers.get('location'), signal ? { signal } : undefined);
  }
  return download;
}

export async function downloadBuildAsset(url, destination, options = {}) {
  // Keep the caller's existing download timeout when adapting @electron/get.
  const timeout = typeof options.timeout === 'number' ? options.timeout : options.timeout?.request;
  const signal = options.signal ?? (timeout ? AbortSignal.timeout(timeout) : undefined);
  const response = await fetchBuildAsset(url, { signal });
  if (!response.ok) throw Object.assign(new Error(`Build asset download failed (${response.status})`), { status: response.status });
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }), { signal });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
