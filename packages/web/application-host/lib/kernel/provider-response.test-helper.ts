import type { ServerResponse } from 'node:http';
import { afterEach } from 'vitest';

const failures: unknown[] = [];
afterEach(() => {
  const errors = failures.splice(0);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Scripted provider callbacks failed');
});

/** Fail the original fixture and finish its HTTP response instead of stranding a native Run. */
export function guardProviderReply(response: ServerResponse, reply: () => void | Promise<void>): () => void {
  const fail = (error: unknown) => {
    failures.push(error);
    if (response.destroyed || response.writableEnded) return;
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('Scripted provider callback failed');
  };
  return () => {
    try { void Promise.resolve(reply()).catch(fail); }
    catch (error) { fail(error); }
  };
}
