/** Test-only finite protocol peer. Process-tree ownership is tested with the Rust process service. */
import { spawn } from 'node:child_process';
import { StdioTransport, type McpAuthorityOptions } from '../mcp/authority.js';
import { createMcpProcessTransport } from './mcp-process-transport.js';
import type { ManagedPipedProcessHandle } from '../process/types.js';

export const fixtureMcpStdio: NonNullable<McpAuthorityOptions['adaptTransport']> = (_scope, transport) => {
  if (!(transport instanceof StdioTransport)) return transport;
  return createMcpProcessTransport(transport.options, options => {
    const child = spawn(options.command, options.args ?? [], { cwd: options.cwd, env: options.inheritEnv === false ? options.env : { ...process.env, ...options.env }, stdio: 'pipe', windowsHide: true });
    let closed = false;
    const completion = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
    Object.defineProperties(child, {
      completion: { value: completion }, exitConfirmed: { get: () => closed },
      requestTermination: { value: async (force = false) => { if (!closed) child.kill(force ? 'SIGKILL' : 'SIGTERM'); } },
    });
    return child as ManagedPipedProcessHandle;
  }, { child: null });
};
