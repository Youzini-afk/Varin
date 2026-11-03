/** Exercise the existing OS registration. Never installs a fake handler or
 * rewrites an executable/URL command to make the test pass. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const run = async (file, args, options = {}) => (await execute(file, args, { ...options, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })).stdout.trim();
async function samePath(left, right, platform) {
  const a = await fs.realpath(left), b = await fs.realpath(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
export function protocolCommandExecutable(command, platform) {
  const match = /^"([^"]+)"(?:\s|$)|^([^\s"]+)(?:\s|$)/u.exec(command);
  const executable = match?.[1] ?? match?.[2];
  if (!executable || !(platform === 'win32' ? /^[a-z]:[\\/]/iu.test(executable) : path.isAbsolute(executable))) throw new Error('OS protocol command is not an explicit application path');
  if (!(platform === 'win32' ? /"%1"/u.test(command) : /(?:^|\s)%[uU](?:\s|$)/u.test(command))) throw new Error('OS protocol command does not forward the URL');
  return executable;
}
export async function verifyProtocolRegistration(executable, { platform = process.platform, environment = process.env } = {}) {
  let registered;
  if (platform === 'win32') {
    const command = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-Item -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\varin\\shell\\open\\command').GetValue('')"], { env: environment });
    registered = protocolCommandExecutable(command, platform);
  } else if (platform === 'darwin') {
    const app = path.dirname(path.dirname(path.dirname(path.resolve(executable))));
    const source = 'import AppKit; import Foundation; guard let url = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "varin://")!) else { exit(2) }; print(url.path)';
    registered = await run('/usr/bin/swift', ['-e', source], { env: environment });
    if (!await samePath(registered, app, platform)) throw new Error('LaunchServices selects another Varin installation');
    return { platform, application: registered };
  } else if (platform === 'linux') {
    const name = await run('xdg-mime', ['query', 'default', 'x-scheme-handler/varin'], { env: environment });
    if (!name || name !== path.basename(name) || !name.endsWith('.desktop')) throw new Error('Varin has no installed desktop URL handler');
    const home = environment.XDG_DATA_HOME || path.join(environment.HOME || os.homedir(), '.local/share');
    const roots = [home, ...(environment.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
    let desktop;
    for (const root of roots) {
      try { desktop = await fs.readFile(path.join(root, 'applications', name), 'utf8'); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!desktop) throw new Error('Registered desktop URL handler is unavailable');
    const section = desktop.split(/\[Desktop Entry\]\r?\n/u)[1]?.split(/\r?\n\[/u)[0];
    if (!section || !(/^MimeType=(.*)$/mu.exec(section)?.[1] || '').split(';').includes('x-scheme-handler/varin')) throw new Error('Registered desktop entry lacks the Varin scheme');
    registered = protocolCommandExecutable(/^Exec=(.*)$/mu.exec(section)?.[1] || '', platform);
  } else throw new Error('Unsupported protocol smoke platform');
  if (!await samePath(registered, executable, platform)) throw new Error('OS URL handler selects another executable, not the installed candidate');
  return { platform, executable: registered };
}
export async function activateWarmProtocol(data, nonce, { environment = process.env, timeoutMs = 120_000, signal } = {}) {
  if (!/^[0-9a-f-]{36}$/u.test(nonce)) throw new Error('Invalid protocol smoke nonce');
  const deadline = Date.now() + timeoutMs;
  let ready;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try { ready = JSON.parse(await fs.readFile(path.join(data, 'smoke-ready.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (ready?.schema !== 1 || ready.nonce !== nonce || !Number.isSafeInteger(ready.pid) || ready.pid <= 0) throw new Error('Native app did not become ready for OS URL activation');
  const url = `varin://smoke/${nonce}`;
  if (process.platform === 'win32') await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:VARIN_PROTOCOL_SMOKE_URL'], { env: { ...environment, VARIN_PROTOCOL_SMOKE_URL: url } });
  else await run(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], { env: environment });
  return ready;
}
