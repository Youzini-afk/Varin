#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { authorizeDesktop } from './oauth.mjs';
import { credentialDirectory, readDesktopClient } from './credentials.mjs';

if (process.argv.length !== 3) {
  console.error('Usage: node runtime/authorize.mjs /path/to/google-desktop-oauth-client.json');
  process.exitCode = 2;
} else {
  try {
    const client = await readDesktopClient(process.argv[2]);
    await authorizeDesktop(client, credentialDirectory(), { onAuthorizationUrl(url) {
      console.log(`Open this URL in your browser to authorize Gmail:\n${url}`);
      if (process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
        const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
      }
    } });
    console.log('Gmail credentials saved for this local user. You may close the browser window.');
  } catch (error) {
    console.error(`Gmail connection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
