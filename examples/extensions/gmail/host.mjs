import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import manifest from './varin.extension.json' with { type: 'json' };
import { createGmailClient } from './runtime/gmail.mjs';

export function createExtension(client = createGmailClient()) {
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
  } });
}
export default createExtension();
