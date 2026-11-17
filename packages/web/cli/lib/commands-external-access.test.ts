import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalAccessCommand } from './commands-external-access.js';
import { parseArgs } from './cli-args.js';

let server: Server, port: number, directory: string;
let requests: { method: string; url: string; origin?: string | undefined; cookie?: string | undefined; body: unknown }[];
let status: number, authenticate: boolean, output: string;
const snapshot = () => ({ source: 'settings', phase: 'disabled', listener: null,
  entry: { revision: 4, enabled: false, configuration: { id: 'entry', provider: 'reverse-proxy', name: 'Home',
    publicOrigin: 'https://varin.example.com', backend: { host: '127.0.0.1', port: 3100 } } } });
const options = () => ({ explicitPort: true, port, json: true });
const config = async (value: unknown) => { const file = join(directory, 'config.json'); await writeFile(file, JSON.stringify(value)); return file; };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'varin-external-cli-'));
  vi.stubEnv('VARIN_DATA_DIR', directory); vi.stubEnv('VARIN_HOST', '127.0.0.1');
  requests = []; status = 200; authenticate = false; output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    requests.push({ method: request.method!, url: request.url!, origin: request.headers.origin,
      cookie: request.headers.cookie, body: text ? JSON.parse(text) : null });
    if (request.url === '/auth/session') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'varin_ui_session=test-session; HttpOnly' });
      response.end('{}'); return;
    }
    if (authenticate && request.headers.cookie !== 'varin_ui_session=test-session') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'UI authentication required' })); return;
    }
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? snapshot() : { error: 'rejected' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it('parses the external-access action and explicit configuration revision', () => {
  const parsed = parseArgs(['external-access', 'config', '--config', 'entry.json', '--expected-revision', 'new']);
  expect(parsed.command).toBe('external-access'); expect(parsed.externalAccessAction).toBe('config');
  expect(parsed.options.configPath).toBe('entry.json'); expect(parsed.options.expectedRevision).toBe('new');
  expect(parsed.removedFlagErrors).toEqual([]);
});

it('reads local status without changing it and does not claim public verification', async () => {
  await externalAccessCommand({ ...options(), json: false }, 'status');
  expect(requests).toEqual([{ method: 'GET', url: '/api/varin/external-access', origin: `http://127.0.0.1:${port}`, cookie: undefined, body: null }]);
  expect(output).toContain('Revision: 4'); expect(output).toContain('Public HTTPS access is not verified.');
});

it.each(['enable', 'disable', 'retry'])('sends %s once with the requested revision and same-origin header', async action => {
  await externalAccessCommand({ ...options(), expectedRevision: '4' }, action);
  expect(requests).toEqual([{ method: 'POST', url: `/api/varin/external-access/${action}`, origin: `http://127.0.0.1:${port}`, cookie: undefined, body: { expectedRevision: 4 } }]);
});

it('creates an FRP configuration with operator references only, never enabling it or forwarding inline secret fields', async () => {
  const frp = { server: { address: 'frp.example.com', port: 7000, tls: { caFile: '/etc/varin/ca.pem', serverName: 'frp.example.com' } },
    proxy: { name: 'varin', remotePort: 18080 }, tokenEnv: 'VARIN_FRP_TOKEN_HOME' };
  const configuration = { ...snapshot().entry.configuration, provider: 'frp', frp: { ...frp, token: 'do-not-forward' } };
  await externalAccessCommand({ ...options(), configPath: await config(configuration), expectedRevision: 'new' }, 'config');
  expect(requests).toHaveLength(1); expect(requests[0]!.method).toBe('PUT');
  const body = requests[0]!.body as { expectedRevision: null; configuration: Record<string, unknown> };
  expect(body.expectedRevision).toBeNull(); expect(body.configuration.frp).toEqual(frp);
  expect(JSON.stringify(requests)).not.toContain('do-not-forward'); expect(output).not.toContain('do-not-forward');
});

it('uses existing UI authentication without sending credentials to the external origin', async () => {
  authenticate = true;
  await externalAccessCommand({ ...options(), expectedRevision: '4', explicitUiPassword: true, uiPassword: 'fixture-password' }, 'enable');
  expect(requests.map(request => request.url)).toEqual(['/api/varin/external-access/enable', '/auth/session', '/api/varin/external-access/enable']);
  expect(requests[1]!.body).toEqual({ password: 'fixture-password' });
  expect(requests[2]!.cookie).toBe('varin_ui_session=test-session');
  expect(requests[2]!.origin).toBe(`http://127.0.0.1:${port}`);
  expect(output).not.toContain('fixture-password'); expect(output).not.toContain('test-session');
});

it('reports a stale revision without fetching a new revision or replaying the mutation', async () => {
  status = 409;
  await expect(externalAccessCommand({ ...options(), expectedRevision: '3' }, 'disable')).rejects.toThrow('review it');
  expect(requests).toHaveLength(1);
});

it('does not retry after a lost response, and explains that the effect is unknown', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('network lost'));
  vi.stubGlobal('fetch', fetch);
  await expect(externalAccessCommand({ ...options(), expectedRevision: '4' }, 'enable')).rejects.toThrow('outcome is unknown');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([undefined, '0', '-1', 'new', '1.5', '9007199254740992'])('refuses action without a usable revision (%s)', async expectedRevision => {
  await expect(externalAccessCommand({ ...options(), expectedRevision }, 'enable')).rejects.toThrow('--expected-revision');
  expect(requests).toHaveLength(0);
});

it.each(['dryRun', 'force', 'all'])('does not ignore unsupported %s intent and accidentally mutate', async flag => {
  await expect(externalAccessCommand({ ...options(), expectedRevision: '4', [flag]: true }, 'enable')).rejects.toThrow('No request was sent');
  expect(requests).toHaveLength(0);
});

it('refuses public/LAN targets before local credentials or configuration are sent', async () => {
  vi.stubEnv('VARIN_HOST', '192.0.2.1');
  await expect(externalAccessCommand({ ...options(), expectedRevision: '4', uiPassword: 'must-stay-local' }, 'enable')).rejects.toThrow('loopback');
  expect(requests).toHaveLength(0);
});
