import { isDeepStrictEqual } from 'node:util';
import type { RecoveryFileTarget } from '@varin/extension-contract';
/** A native branch/scope root survives remounting; its old absolute path is
 * historical evidence. All other target fields retain their exact identity. */
export function sameRecoveryFileTarget(left: unknown, right: unknown): boolean {
    const identity = (value: unknown): unknown => {
        if (!value || typeof value !== 'object')
            return value;
        const target = value as RecoveryFileTarget;
        if (target.kind === 'physical' && target.sourceMode === 'native_workspace')
            return { ...target, canonicalRoot: '' };
        if (target.kind === 'managed')
            return { ...target, target: identity(target.target) };
        return value;
    };
    return isDeepStrictEqual(identity(left), identity(right));
}
