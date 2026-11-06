#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the installed Host's normal authentication and brokered service route.
// Never print session cookies, credentials, response bodies or workspace records.
export async function createInstalledServiceInvoker({ baseUrl, password }) {
  const origin = new URL(baseUrl).origin;
  const headers = { 'content-type': 'application/json', origin };
  const post = async (pathname, body) => {
    const response = await fetch(new URL(pathname, origin), {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Installed service smoke ${pathname} failed (HTTP ${response.status})`);
    }
    return response;
  };
  if (password) {
    const response = await post('/auth/session', { password });
    const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    await response.arrayBuffer();
    if (!cookie) throw new Error('Installed service smoke login returned no session cookie');
    headers.cookie = cookie;
  }
  return async (request) => {
    const response = await post('/api/varin/extensions/v1/services/invoke', request);
    try { return (await response.json()).result; }
    catch { throw new Error('Installed service smoke returned invalid JSON'); }
  };
}

export async function smokeCloudServices({ baseUrl, runtimeRoot, password = process.env.VARIN_UI_PASSWORD }) {
  const contractUrl = pathToFileURL(path.resolve(runtimeRoot, 'packages/extension-contract/dist/index.js'));
  const { createWorkspaceRecoveryAPI } = await import(contractUrl.href);
  const invoke = await createInstalledServiceInvoker({ baseUrl, password });
  const result = await createWorkspaceRecoveryAPI(invoke).listStorageWorkspaces();
  if (result.status !== 'ready') throw new Error('Installed workspace recovery service is not ready');
  return { brokeredWorkspaceRecovery: 'ready' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await smokeCloudServices({
      baseUrl: process.argv[2] ?? 'http://127.0.0.1:3000',
      runtimeRoot: process.argv[3] ?? '.',
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Installed service smoke failed');
    process.exitCode = 1;
  }
}
