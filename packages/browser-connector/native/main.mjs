#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectorBridge } from './bridge.mjs';
import { createNativeDecoder, encodeNativeMessage } from './framing.mjs';

// The generated launcher supplies a fixed config path; extension messages cannot
// choose endpoints, credentials, files, executables or pairing sessions.
export async function runNativeHost({ configPath, origin, input = process.stdin, output = process.stdout }) {
  const path = resolve(configPath);
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.includes(origin)
    || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)) throw new Error('Native caller is not registered');
  if (typeof config.credentialFile !== 'string') throw new Error('An existing approved Varin credential file is required');
  const credentialPath = resolve(dirname(path), config.credentialFile);
  const info = await stat(credentialPath);
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('The approved credential file must be readable only by its owner');
  const credentials = JSON.parse(await readFile(credentialPath, 'utf8'));
  const clientToken = credentials.clientToken;
  if (typeof clientToken !== 'string' || !clientToken.startsWith('varin_client_')) throw new Error('No approved Varin client bearer is available');
  const send = value => output.write(encodeNativeMessage(value));
  const bridge = new ConnectorBridge({ endpoint: config.hostUrl, clientToken, send,
    onStop: () => { input.destroy(); output.end(); } });
  const decoder = createNativeDecoder(value => bridge.accept(value));
  input.on('data', chunk => { try { decoder.push(chunk); } catch { bridge.stop(); } });
  input.on('end', () => { try { decoder.end(); } catch { /* teardown remains fail closed */ } bridge.stop(); });
  input.on('error', () => bridge.stop()); output.on('error', () => bridge.stop());
  return bridge;
}
if (process.argv[1] && (resolve(process.argv[1]) === fileURLToPath(import.meta.url) || typeof Bun !== 'undefined' && Bun.main === import.meta.path)) {
  const index = process.argv.indexOf('--config');
  const origin = process.argv.find(value => /^chrome-extension:\/\//.test(value));
  runNativeHost({ configPath: index >= 0 ? process.argv[index + 1] : resolve(dirname(process.execPath), 'browser-connector.json'), origin })
    .catch(() => { process.stderr.write('Varin browser connector could not start. Check its approved local configuration.\n'); process.exitCode = 1; });
}
