import { readFile } from 'node:fs/promises';
import type { ExternalAccessSnapshot } from '@varin/application-client';
import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { resolveTargetPort } from './cli-api-target.js';
import { requestJson } from './cli-http.js';
import { buildLocalUrl } from './cli-network.js';
import { isJsonMode, printJson } from '../cli-output.js';
import { recordOf, type CliOptions } from './cli-types.js';

const endpoint = '/api/varin/external-access';
const usage = `Varin Self-hosted External Access

USAGE:
  varin external-access status [--json]
  varin external-access check [--json]
  varin external-access config [--json]
  varin external-access config --config <file.json> --expected-revision <number|new>
  varin external-access <enable|disable|retry|remove> --expected-revision <number>

OPTIONS:
  -p, --port <port>            Trusted local Host management port
  --config <file.json>         Full replacement configuration, not frpc TOML
  --expected-revision <value>  Revision from status/config; 'new' creates the first entry
  --json                      Machine-readable output
  --ui-password <password>     Existing local UI authentication (prefer VARIN_UI_PASSWORD)

Saving and enabling are separate. Replacing an enabled entry may disconnect its clients.
FRP JSON accepts server {address, port, tls: {caFile, serverName}}, proxy {name, remotePort},
and tokenEnv inside 'frp'. Provide only a VARIN_FRP_TOKEN[_*] variable name, never its value.
The CA path and token environment belong to the Host, not the computer viewing a browser.
No installation or deployment is performed. Status reports the Host’s current verification result.
These commands use the trusted local management endpoint, never a public ingress URL.
After a conflict or lost response, inspect status before explicitly issuing another command.
`;

function expectedRevision(options: CliOptions, create: boolean): number | null {
  if (create && options.expectedRevision === 'new') return null;
  const value = String(options.expectedRevision ?? '');
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TunnelCliError(`Supply --expected-revision from status/config${create ? ", or 'new' for the first configuration" : ''}.`, EXIT_CODE.USAGE_ERROR);
  }
  return Number(value);
}

// This is an allowlist for the wire request, not a second configuration validator.
// In particular arbitrary input keys (including inline secrets) are never forwarded.
function configurationForRequest(value: unknown): Record<string, unknown> {
  const input = recordOf(value), backend = recordOf(input.backend);
  const base = { name: input.name, provider: input.provider, publicOrigin: input.publicOrigin,
    backend: { host: backend.host, port: backend.port } };
  if (input.provider === 'reverse-proxy' || input.provider === 'external-forwarding') return base;
  if (input.provider !== 'frp') throw new TunnelCliError('Configuration provider must be reverse-proxy, external-forwarding or frp.', EXIT_CODE.USAGE_ERROR);
  const frp = recordOf(input.frp), server = recordOf(frp.server), tls = recordOf(server.tls), proxy = recordOf(frp.proxy);
  if (typeof frp.tokenEnv !== 'string' || !/^VARIN_FRP_TOKEN(?:_[A-Z0-9_]+)?$/.test(frp.tokenEnv)) {
    throw new TunnelCliError('FRP requires a VARIN_FRP_TOKEN or VARIN_FRP_TOKEN_* environment variable name, not a token value.', EXIT_CODE.USAGE_ERROR);
  }
  return { ...base, frp: { server: { address: server.address, port: server.port, tls: { caFile: tls.caFile, serverName: tls.serverName } },
    proxy: { name: proxy.name, remotePort: proxy.remotePort }, tokenEnv: frp.tokenEnv } };
}

async function externalAccessCommand(options: CliOptions = {}, action = 'status'): Promise<void> {
  if (action === 'help') { process.stdout.write(usage); return; }
  if (!['status', 'check', 'config', 'enable', 'disable', 'retry', 'remove'].includes(action)) {
    throw new TunnelCliError(`Unknown external-access command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }
  if (options.dryRun || options.force || options.all) {
    throw new TunnelCliError('external-access does not support --dry-run, --force or --all. No request was sent.', EXIT_CODE.USAGE_ERROR);
  }
  if (options.server || options.host || options.hostname || options.token || options.tokenFile || options.tokenStdin || options.showSecrets) {
    throw new TunnelCliError('Use --port for the trusted local Host. External access commands do not accept remote URLs or inline tunnel credentials.', EXIT_CODE.USAGE_ERROR);
  }
  const localOrigin = new URL(buildLocalUrl(1)).origin;
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(new URL(localOrigin).hostname)) {
    throw new TunnelCliError('External access management requires a loopback VARIN_HOST. Use the Host locally, not a public or LAN endpoint.', EXIT_CODE.USAGE_ERROR);
  }
  if (options.configPath !== undefined && (action !== 'config' || !options.configPath)) {
    throw new TunnelCliError('Use config --config <file.json> to replace the saved configuration.', EXIT_CODE.USAGE_ERROR);
  }
  const check = action === 'check';
  const write = action !== 'status' && !check && (action !== 'config' || typeof options.configPath === 'string');
  let body: unknown;
  if (write) {
    const revision = expectedRevision(options, action === 'config');
    if (action === 'config') {
      let input: unknown;
      try { input = JSON.parse(await readFile(options.configPath!, 'utf8')); }
      catch { throw new TunnelCliError('Could not read the configuration JSON file. No request was sent.', EXIT_CODE.USAGE_ERROR); }
      body = { expectedRevision: revision, configuration: configurationForRequest(input) };
    } else body = { expectedRevision: revision };
  }
  const port = await resolveTargetPort(options);
  const url = action === 'status' || action === 'config' || action === 'remove' ? endpoint : `${endpoint}/${action}`;
  let result;
  try {
    result = await requestJson(port, url, { ...options, timeoutMs: options.timeoutMs ?? 30_000,
      headers: { Origin: new URL(buildLocalUrl(port)).origin },
      ...(check ? { method: 'POST' } : write ? { method: action === 'config' ? 'PUT' : action === 'remove' ? 'DELETE' : 'POST', body: JSON.stringify(body) } : {}) });
  } catch {
    throw new TunnelCliError(write
      ? 'The request outcome is unknown. It was not repeated. Inspect external-access status before issuing another write.'
      : check ? 'Could not complete the HTTPS diagnostic from the local Host.' : 'Could not read external-access status from the local Host.', EXIT_CODE.GENERAL_ERROR);
  }
  if (!result.response.ok) {
    const message = result.response.status === 409 && !check
      ? 'Configuration changed or is environment-managed. Read status/config, review it, then explicitly use the latest revision.'
      : result.response.status === 401 || result.response.status === 403
        ? 'Local owner authorization is required. Use the Host management port and its existing desktop or UI authentication.'
        : typeof result.body?.error === 'string' ? result.body.error : 'The Host rejected the external access request.';
    throw new TunnelCliError(message, result.response.status === 400 ? EXIT_CODE.USAGE_ERROR : EXIT_CODE.GENERAL_ERROR);
  }
  const snapshot = result.value as ExternalAccessSnapshot;
  if (isJsonMode(options) || action === 'config') {
    printJson(action === 'config' ? { source: snapshot.source, entry: snapshot.entry } : snapshot); return;
  }
  process.stdout.write(`External access: ${snapshot.phase}\nSource: ${snapshot.source}\n`);
  if (snapshot.entry) process.stdout.write(`Revision: ${snapshot.entry.revision}\nEnabled: ${snapshot.entry.enabled}\nPublic origin: ${snapshot.entry.configuration.publicOrigin}\n`);
  if (snapshot.error) process.stdout.write(`Error: ${snapshot.error}\n`);
  if (snapshot.accessCheck) {
    process.stdout.write(`Public HTTPS: ${snapshot.accessCheck.state}${snapshot.accessCheck.reason ? ` (${snapshot.accessCheck.reason})` : ''} — ${snapshot.accessCheck.origin}\n`);
  } else process.stdout.write('Public HTTPS access has not been checked. Run external-access check.\n');
}

export { externalAccessCommand };
