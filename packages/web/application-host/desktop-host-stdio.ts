import { Console } from 'node:console';
import { StringDecoder } from 'node:string_decoder';
import { createDesktopHostDecoder, createDesktopHostWriter } from './desktop-host-codec.js';
import type { createDesktopHostSession } from './lib/platform/desktop-host-session.js';

/** Shared inherited-pipe plumbing. Both the full Host and browser-only process
 * use this boundary; this module never imports either product owner. */
export function createDesktopHostStdio() {
  const writeProtocol = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  const send = createDesktopHostWriter('host', line => new Promise<void>((resolve, reject) => {
    writeProtocol(line, error => error ? reject(error) : resolve());
  }));
  const frames = createDesktopHostDecoder('shell');
  let exiting = false;
  const exit = (code: number) => {
    if (exiting) return; exiting = true;
    // Control priority must not truncate another logical frame at process exit.
    void send.close().then(() => process.exit(code), () => process.exit(1));
  };
  return {
    exit,
    send,
    async run(session: ReturnType<typeof createDesktopHostSession>): Promise<void> {
      const decoder = new StringDecoder('utf8');
      let buffered = '';
      let inputClosed = false;
      // Escaped UTF-8 chunks remain under this bound. Logical assembly has its
      // own aggregate budget; binary file transfers do not use these frames.
      const maxFrameBytes = 1024 * 1024;
      const failProtocol = () => {
        if (inputClosed) return;
        inputClosed = true; process.stdin.pause(); frames.clear();
        console.error('[desktop-host] Invalid private control stream');
        session.disconnect(1);
      };
      process.stdin.on('data', (chunk: Buffer) => {
        if (inputClosed) return;
        buffered += decoder.write(chunk);
        for (;;) {
          const end = buffered.indexOf('\n');
          if (end < 0) break;
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (Buffer.byteLength(line) > maxFrameBytes) { failProtocol(); return; }
          try {
            const frame = frames.accept(JSON.parse(line));
            if (frame) void session.receive(frame).catch(failProtocol);
          } catch { failProtocol(); return; }
        }
        if (Buffer.byteLength(buffered) > maxFrameBytes) failProtocol();
      });
      process.stdin.once('end', () => {
        if (buffered.length || decoder.end()) { failProtocol(); return; }
        try { frames.finish(); } catch { failProtocol(); return; }
        inputClosed = true; frames.clear(); session.disconnect();
      });
      process.stdin.once('error', () => { inputClosed = true; frames.clear(); session.disconnect(1); });
      process.stdout.once('error', () => session.disconnect(1));
      process.once('SIGTERM', () => session.disconnect());
      process.once('SIGINT', () => session.disconnect());
      try { await session.start(); }
      catch (error) {
        // Error messages can contain provider bodies or malformed settings. Keep
        // private protocol/credential data out of process logs as well.
        console.error('[desktop-host] Startup failed:', error instanceof Error ? error.name : 'UnknownError');
        try { await session.stop(); } catch { /* Real shutdown remains unsuccessful. */ }
        exit(1);
      }
    },
  };
}
