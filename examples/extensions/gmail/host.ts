import { randomUUID } from 'node:crypto';
import { defineHostExtension, provideTool, credentials, credentialNamespace, assertCredentialAuthentication, confirmToolEffect, type VarinHostServiceInvocationContext } from '@varin/extension-sdk';
import { parseVarinExtensionManifest, parseVarinToolJson, type JsonValue, type VarinCredentialAuthenticationCall } from '@varin/extension-contract';
import rawManifest from './varin.extension.json' with { type: 'json' };
import { executeGmail, type GmailBinding, type Accounts } from './gmail.js';
import { authenticate, configuration } from './oauth.js';
const manifest = parseVarinExtensionManifest(rawManifest);
const adapter = { serviceId: 'varin.gmail.oauth', version: 1, provider: 'gmail' };
const json = async (result: Promise<unknown>): Promise<JsonValue> => parseVarinToolJson(await result);
export default defineHostExtension({
  activate(context) {
    const document = async (call: VarinHostServiceInvocationContext) => context.storage.open({ key: `connections-${await credentialNamespace(call.capabilities)}`, scope: 'application' });
    const ids = async (call: VarinHostServiceInvocationContext) => {
      const doc = await document(call), snapshot = await doc.refresh();
      const values = snapshot.document.data.connections;
      if (values !== undefined && (!Array.isArray(values) || values.some(v => typeof v !== 'string'))) throw new Error('Invalid Gmail connection configuration');
      return { doc, snapshot, values: (values ?? []) as string[] };
    };
    // Serialize settings mutations within this generation. Cross-generation writes still use
    // the storage owner's expected revision; conflicts fail without starting OAuth.
    const mutations = new Map<string, Promise<unknown>>();
    const changeConnections = async (call: VarinHostServiceInvocationContext, change: (values: string[]) => string[]) => {
      const namespace = await credentialNamespace(call.capabilities);
      const previous = mutations.get(namespace) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        const { doc, snapshot, values } = await ids(call);
        await doc.update({ connections: change(values) }, snapshot.document.revision);
      });
      mutations.set(namespace, next);
      try { await next; } finally { if (mutations.get(namespace) === next) mutations.delete(namespace); }
    };
    const forget = (call: VarinHostServiceInvocationContext, connectionId: string) => changeConnections(call, values => values.filter(id => id !== connectionId));
    const list = async (call: VarinHostServiceInvocationContext) => {
      const { values } = await ids(call);
      const results = await Promise.all(values.map(async connectionId => ({ connectionId, ...await credentials(call.capabilities, connectionId).inspect() })));
      return results.filter(value => value.connected && value.account && value.accountId).map(value => ({ connectionId: value.connectionId, account: value.account!, accountId: value.accountId! }));
    };
    context.services.provide(manifest.provides!.services!.find(s => s.id === adapter.serviceId)!, {
      authenticate: async (args, call) => {
        await assertCredentialAuthentication(call.capabilities);
        return json(authenticate(args[0] as unknown as VarinCredentialAuthenticationCall, configuration(), fetch, call.signal));
      },
    });
    context.services.provide(manifest.provides!.services![0]!, {
      list: (_args, call) => json(list(call)),
      connect: async (_args, call) => {
        configuration();
        const connectionId = randomUUID();
        await changeConnections(call, values => [...values, connectionId]);
        try { return await json(credentials(call.capabilities, connectionId).start(adapter).then(attempt => ({ ...attempt, connectionId }))); }
        catch (error) { await forget(call, connectionId); throw error; }
      },
      readAttempt: async (args, call) => {
        const connectionId = String(args[0]), attempt = await credentials(call.capabilities, connectionId).read(String(args[1]));
        if (attempt.status === 'cancelled' || attempt.status === 'failed') await forget(call, connectionId);
        return json(Promise.resolve(attempt));
      },
      reply: (args, call) => json(credentials(call.capabilities, String(args[0])).reply(String(args[1]), String(args[2]))),
      cancel: async (args, call) => {
        const connectionId = String(args[0]), attempt = await credentials(call.capabilities, connectionId).cancel(String(args[1]));
        if (attempt.status === 'cancelled' || attempt.status === 'failed') await forget(call, connectionId);
        return json(Promise.resolve(attempt));
      },
      disconnect: async (args, call) => {
        const input = args[0] as unknown as { binding: GmailBinding; revoke: boolean };
        if (!input?.binding?.connectionId || !input.binding.account || typeof input.revoke !== 'boolean') throw new Error('Invalid Gmail disconnect request');
        const credential = credentials(call.capabilities, input.binding.connectionId, input.binding.account);
        if (input.revoke) {
          const token = await credential.resolve(adapter);
          if (token.kind !== 'oauth') throw new Error('Gmail OAuth credential unavailable');
          const result = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: token.refreshToken ?? token.accessToken }), redirect: 'error', signal: call.signal });
          if (!result.ok) throw new Error(`Google revocation failed (HTTP ${result.status}); local connection retained`);
        }
        await credential.remove();
        await forget(call, input.binding.connectionId);
        return { revocation: input.revoke ? 'revoked' : 'not-requested' };
      },
    });
    for (const declaration of manifest.provides!.services!.filter(s => s.tool)) {
      provideTool(context, declaration, (input, call) => {
        const accounts: Accounts = {
          list: () => list(call), confirm: input => confirmToolEffect(call.capabilities, input),
          request: async request => {
            const token = await credentials(call.capabilities, request.binding.connectionId, request.binding.account).resolve(adapter);
            if (token.kind !== 'oauth') throw new Error('Gmail OAuth credential unavailable');
            const response = await fetch(request.url, { method: request.method ?? 'GET', headers: { ...request.headers, Authorization: `Bearer ${token.accessToken}` }, ...(request.body ? { body: request.body } : {}), redirect: 'error', signal: call.signal });
            return { status: response.status, body: await response.text() };
          },
        };
        return executeGmail(declaration.tool!.name, input as Record<string, unknown>, accounts);
      });
    }
  },
});
