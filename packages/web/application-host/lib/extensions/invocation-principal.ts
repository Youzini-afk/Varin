/** Host-only annotations. Neither extension JSON nor routing labels establish a user. */
import type { HostCapabilityCallContext, HostInvocationScope } from '@varin/extension-host';
const subjects = new WeakMap<HostInvocationScope, { principalId: string; valid(context: HostCapabilityCallContext): boolean }>();
export function bindPluginInvocationPrincipal(scope: HostInvocationScope, principalId: string,
  valid: (context: HostCapabilityCallContext) => boolean = context => !context.signal.aborted): () => void {
  if (!principalId || subjects.has(scope)) throw new Error('plugin_principal_binding_invalid');
  subjects.set(scope, { principalId, valid });
  return () => { subjects.delete(scope); };
}
export function requirePluginPrincipal(context: HostCapabilityCallContext): string {
  const subject = context.invocation ? subjects.get(context.invocation) : undefined;
  if (!subject || context.signal.aborted || !subject.valid(context)) throw new Error('Authenticated plugin user unavailable');
  return subject.principalId;
}
