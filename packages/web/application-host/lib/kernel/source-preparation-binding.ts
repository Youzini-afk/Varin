import { isDeepStrictEqual } from 'node:util';
import type { ThreadPrepareSource, ThreadPreparedSource } from '@varin/application-client';
import { resourceSource } from './thread-context.js';

/** The authenticated source owner attests the original registration and the exact
 * prepared view. This is not authority supplied by a renderer or a new grant. */
export function matchesSourcePreparation(input: ThreadPrepareSource, prepared: ThreadPreparedSource): boolean {
  const binding = prepared.sourcePreparation;
  if (!binding || binding.threadId !== input.threadId || binding.branchId !== input.branchId || binding.key !== input.key
    || binding.workspaceId !== input.workspaceId || binding.mode !== input.mode
    || !isDeepStrictEqual(binding.resourceOwner, input.resourceOwner)
    || !isDeepStrictEqual(prepared.source.resourceOwner, input.resourceOwner)
    || !binding.nativeSource || binding.nativeSource.mode !== 'native_workspace'
    || !binding.nativeSource.branch_id || !binding.nativeSource.execution_workspace_id
    || binding.nativeSource.workspace_id !== prepared.source.workspaceId
    || !isDeepStrictEqual(binding.nativeSource.resource_owner, input.resourceOwner)
    || !isDeepStrictEqual(binding.preparedSource, resourceSource(prepared.source))) return false;
  if (input.mode === 'live_root' || input.mode === 'native_workspace') {
    return isDeepStrictEqual(binding.nativeSource, binding.preparedSource);
  }
  // A captured subtree is the new branch root, not the original branch plus scope.
  return !binding.preparedSource.native_scope;
}
