/** Semantic authorization for the existing settings invocation, before any owner mutation. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getSettingsCatalogEntry, type ModelChannel } from '@varin/application-client';
import type { PermissionSubject } from '@varin/protocol';
import { getSettingsActionContract } from './settings-action-contracts.js';
import { applyModelChannelPatch } from '../models/channel-patch.js';
import { modelEndpoint } from '../models/connection.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const exactPattern = (value: string) => `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Destination/account/transport authority, not inference or provider-relative API shape.
 * The model owner rejects external/traversing suffix paths; role-specific overrides
 * use that same credential-free path contract. Opaque provider parameters remain
 * conservative until their owner declares routing-independent fields. */
export function modelCredentialRouting(channel: ModelChannel): unknown {
  return { id: channel.id, type: channel.type, baseUrl: channel.baseUrl, authentication: channel.authentication,
    headers: channel.connection?.headers ?? {}, proxy: channel.connection?.proxy ?? null, parameters: channel.parameters };
}

export interface SettingsPermissionSubjectsDeps {
  /** The revisioned owner's stored channels, before directory enrichment or secret redaction. */
  models(): { file: { read(): Promise<{ revision: string; document: { channels: ModelChannel[] } }> } };
}

/** Mutating settings use semantic subjects; reads and unrelated tools retain ordinary tool-wide policy. */
export function createSettingsPermissionSubjects(deps: SettingsPermissionSubjectsDeps) {
  return async (tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<PermissionSubject[] | undefined> => {
    if (!['settings_update', 'settings_action'].includes(tool)) return undefined;
    signal.throwIfAborted();
    const subject = (id: string, values: Record<string, unknown>, target: string, authority?: string, label = target): PermissionSubject => ({
      tool, arguments: { ...values, id, settingsTarget: target }, label,
      ...(authority === undefined ? {} : { authority }),
      persistMatch: { param: 'settingsTarget', pattern: exactPattern(target) },
    });
    if (tool === 'settings_update') {
      const items = Array.isArray(args.items) ? args.items : [args];
      return items.flatMap(item => {
        if (!record(item) || typeof item.id !== 'string') throw new Error('settings_permission_target_invalid');
        const entry = getSettingsCatalogEntry(item.id);
        const scope = item.scope ?? entry?.scope ?? (entry?.owner === 'agent-settings' ? 'global' : entry?.owner === 'client' ? 'client' : 'host');
        const fields = entry?.fields ?? (entry?.field ? [entry.field] : []);
        const paths = [...new Set([...Object.keys(record(item.set) ? item.set : {}),
          ...(Array.isArray(item.reset) ? item.reset.filter((path): path is string => typeof path === 'string') : [])])];
        // The facade accepts only these declared leaves. A mixed object cannot clear
        // an omitted management subfield by replacing its ordinary parent root.
        return (paths.length ? paths : ['']).map(path => {
          const field = fields.find(field => field.path === path);
          const authority = field?.authority ?? entry?.authority;
          const target = `${scope}:${item.id}${path ? `:${path}` : ''}`;
          const label = authority === 'credentials' ? `Credential routing management for ${target} (future values)`
            : authority === 'permissions' ? `Policy management for ${target} (future values)` : target;
          return subject(item.id as string, { ...item, settingsField: path }, target,
            authority ? `settings:${authority}` : undefined, label);
        });
      });
    }
    if (typeof args.id !== 'string' || typeof args.verb !== 'string') throw new Error('settings_permission_target_invalid');
    const id = args.id, verb = args.verb, values = record(args.args) ? args.args : {};
    const entry = getSettingsCatalogEntry(id);
    let actionAuthority = (entry ? getSettingsActionContract(entry, verb)?.authority : undefined) ?? entry?.authority;
    if (entry?.actionRef?.domain === 'runtime:mcp' && verb === 'patch') {
      const paths = [...Object.keys(record(values.set) ? values.set : {}), ...(Array.isArray(values.reset) ? values.reset : [])];
      if (paths.some(path => typeof path === 'string' && /^(command|args|cwd|type|url|env|headers|auth|oauth)(\.|$)/.test(path))) actionAuthority = 'credentials';
    }
    const target = `${id}:${verb}`;
    if (entry?.actionRef?.domain === 'service:web-search' && verb === 'patch' && record(values.set) && 'endpoint' in values.set) actionAuthority = 'credentials';
    if (entry?.actionRef?.domain === 'runtime:providers' && ['save', 'patch'].includes(verb)) {
      const snapshot = await deps.models().file.read();
      signal.throwIfAborted();
      // The mutation checks this same revision. A stale draft must not obtain a new credential grant.
      if (values.expectedRevision !== snapshot.revision) throw new Error('Model settings changed; read the channel again before authorizing its update');
      let candidate: ModelChannel;
      if (verb === 'save') {
        if (!record(values.channel) || typeof values.channel.id !== 'string') throw new Error('A complete model channel is required');
        candidate = values.channel as unknown as ModelChannel;
      } else {
        const current = snapshot.document.channels.find(channel => channel.id === values.id);
        if (!current) throw new Error('Model channel is unavailable');
        candidate = applyModelChannelPatch(current, {
          ...(values.set !== undefined ? { set: values.set as Record<string, unknown> } : {}),
          ...(values.reset !== undefined ? { reset: values.reset as string[] } : {}),
        });
      }
      const current = snapshot.document.channels.find(channel => channel.id === candidate.id);
      const routing = modelCredentialRouting(candidate);
      const changed = !current || !isDeepStrictEqual(modelCredentialRouting(current), routing);
      const usesCredential = candidate.authentication.kind !== 'none'
        || Object.keys(candidate.connection?.headers ?? {}).length > 0
        || Object.keys(candidate.parameters).length > 0;
      // Only plainly anonymous routing has no credential to delegate. Opaque custom headers/
      // provider parameters are not evidence of anonymity; model/budget-only edits retain ordinary scope.
      const authority = changed && usesCredential ? `model-credentials:${fingerprint(routing)}` : undefined;
      const destination = modelEndpoint(candidate.baseUrl).toString();
      return [subject(id, args, `${target}:${candidate.id}`, authority,
        authority ? `Credential routing for ${candidate.id}: ${destination} (exact account, proxy, headers and provider parameters)` : `Model channel ${candidate.id}: ${verb}`)];
    }
    // Preserve each resource selector, not just the action verb: a grant for one
    // account/provider, MCP source/server or extension cannot drift to another.
    const selectorValues: Record<string, unknown> = { ...values, ...(typeof args.operationId === 'string' ? { operationId: args.operationId } : {}) };
    const selectors = Object.fromEntries(['provider', 'mode', 'reference', 'operationId', 'id', 'name', 'path', 'clientId',
      'extensionId', 'profileId', 'projectId', 'contributionId', 'surface', 'scopeId', 'languageId']
      .filter(key => typeof selectorValues[key] === 'string').map(key => [key, selectorValues[key]]));
    const selected = Object.keys(selectors).length ? canonical(selectors) : undefined;
    return [subject(id, args, selected ? `${target}:${selected}` : target,
      actionAuthority ? `settings:${actionAuthority}` : undefined)];
  };
}
