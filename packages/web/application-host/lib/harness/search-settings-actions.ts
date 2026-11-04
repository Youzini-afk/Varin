import type { SettingsActionAdapter, ActionInvocation } from './settings-actions.js';
import type { SearchConnectionSettings } from './search-connection-settings.js';
import { ModelConfigurationError } from '../models/configuration.js';

const credentialResult = (value: ReturnType<SearchConnectionSettings['credentialRequest']>): ActionInvocation => ({
  status: value.status === 'pending' ? 'pending' : value.status === 'completed' ? 'applied' : 'failed',
  data: value,
  operation: { id: value.id, state: value.status === 'pending' ? 'running' : value.status === 'completed' ? 'succeeded' : value.status,
    ...(value.status === 'pending' ? { cancelVerb: 'cancel' } : {}) },
});

export const createSearchSettingsAdapter = (getOwner: () => SearchConnectionSettings | undefined): SettingsActionAdapter => ({
  verbs: ['list', 'add', 'patch', 'remove', 'route', 'restore-default', 'test', 'credential-status', 'enter-credential', 'remove-credential'],
  async describe() {
    const owner = getOwner();
    return owner ? { data: await owner.list() } : { unavailable: 'Search connection settings are unavailable on this Host.' };
  },
  capabilities(_ctx, _entry, verb) { return verb === 'enter-credential' ? { execution: 'async', operation: { query: true, cancel: true } } : { execution: 'sync' }; },
  async getOperation(_ctx, _entry, id) {
    const owner = getOwner();
    if (!owner) return { status: 'unavailable', mutation: 'none', detail: 'Search connection settings are unavailable.' };
    try { return credentialResult(owner.credentialRequest(id)); }
    catch { return { status: 'failed', mutation: 'none', detail: 'Credential entry ended with its Host session. Start a new entry request.', operation: { id, state: 'failed' } }; }
  },
  async cancelOperation(_ctx, _entry, id) {
    const owner = getOwner();
    if (!owner) return { status: 'unavailable', mutation: 'none' };
    return credentialResult(owner.cancelCredential(id));
  },
  async invoke(ctx, _entry, verb, args) {
    const owner = getOwner();
    if (!owner) return { status: 'unavailable', mutation: 'none', detail: 'Search connection settings are unavailable on this Host.' };
    const id = args.id as string;
    const transition = ctx.caller.permissionSettingsRevision;
    const revision = transition && args.expectedRevision === transition.before ? transition.after : args.expectedRevision as string;
    try {
      switch (verb) {
        case 'list': return { status: 'applied', mutation: 'none', data: await owner.list() };
        case 'add': return { status: 'applied', mutation: 'applied', data: await owner.add(revision, args.connection as Parameters<typeof owner.add>[1]) };
        case 'patch': return { status: 'applied', mutation: 'applied', data: await owner.patch(revision, id, args.set as Parameters<typeof owner.patch>[2]) };
        case 'remove': return { status: 'applied', mutation: 'applied', data: await owner.remove(revision, id) };
        case 'route': return { status: 'applied', mutation: 'applied', data: await owner.route(revision, args.set as Parameters<typeof owner.route>[1]) };
        case 'restore-default': return { status: 'applied', mutation: 'applied', data: await owner.restoreDefault(revision) };
        case 'credential-status': return { status: 'applied', mutation: 'none', data: await owner.credential(id) };
        case 'remove-credential': return { status: 'applied', mutation: 'applied', data: await owner.removeCredential(id) };
        case 'enter-credential': return credentialResult(await owner.requestCredential(id, ctx.caller));
        case 'test': {
          const result = await owner.test(id, ctx.caller.signal);
          return { status: ['ok', 'empty'].includes(result.status) ? 'applied' : 'failed', mutation: 'none', data: result };
        }
        default: return { status: 'unavailable', mutation: 'none', detail: `Unsupported search connection action: ${verb}` };
      }
    } catch (error) {
      return { status: 'failed', ...(error instanceof ModelConfigurationError || ['enter-credential', 'test', 'list', 'credential-status'].includes(verb) ? { mutation: 'none' as const } : {}),
        detail: error instanceof Error ? error.message : 'Search connection action failed.' };
    }
  },
});
