import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import manifest from './varin.extension.json' with { type: 'json' };
import { createGmailClient } from './runtime/gmail.mjs';
import { createConnectionController } from './runtime/connection.mjs';

export function createExtension(client = createGmailClient(), connection = createConnectionController()) {
  return defineHostExtension({ activate(context) {
    provideTool(context, manifest.provides.services[0], async () => client.status());
    provideTool(context, manifest.provides.services[1], async (input, call) => client.search(input, call.signal));
    provideTool(context, manifest.provides.services[2], async (input, call) => client.read(input, call.signal));
    provideTool(context, manifest.provides.services[3], async (input, call) => {
      const result = await client.send(input, call.signal);
      // An effect tool's returned value is interpreted by Varin as a confirmed effect. Never
      // return an ambiguous/rejected delivery as a successful callback; the Host will record
      // it conservatively as indeterminate. An operator must inspect Sent before retrying.
      if (result.status !== 'sent') throw new Error(result.message);
      return result;
    });
    context.services.provide(manifest.provides.services[4], {
      status: () => connection.status(),
      start: ([clientJson]) => connection.start(clientJson),
      cancel: () => connection.cancel(),
      check: (_args, call) => connection.check(call.signal),
      disconnect: (_args, call) => connection.disconnect(call.signal),
    });
    context.effect(() => connection.dispose());
  } });
}
export default createExtension();
