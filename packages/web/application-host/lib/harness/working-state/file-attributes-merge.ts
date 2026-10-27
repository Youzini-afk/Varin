import type { NativeFileMetadata } from '../../recovery/journal-files.js';
import { nativeMetadataIdentity } from '../../recovery/journal-files.js';
type Merged<T> = {
    clean: true;
    value: T;
} | {
    clean: false;
};
const equal = (a: unknown, b: unknown) => nativeMetadataIdentity(a) === nativeMetadataIdentity(b);
const select = <T>(base: T, parent: T, child: T): Merged<T> => {
    if (equal(parent, child))
        return { clean: true, value: parent };
    if (equal(base, parent))
        return { clean: true, value: child };
    if (equal(base, child))
        return { clean: true, value: parent };
    return { clean: false };
};
/** Independent properties and individual xattrs merge without forcing a body
 * read. Security descriptors and reparse payloads remain indivisible values. */
export const mergeFileAttributes = (base: NativeFileMetadata | undefined, parent: NativeFileMetadata | undefined, child: NativeFileMetadata | undefined): Merged<NativeFileMetadata | undefined> => {
    const unchanged = select(base, parent, child);
    if (unchanged.clean)
        return unchanged;
    if (!base || !parent || !child)
        return { clean: false };
    const result = { ...parent, xattrs: { ...parent.xattrs } };
    for (const field of ['uid', 'gid', 'created', 'backup', 'security', 'reparseData'] as const) {
        const merged = select(base[field], parent[field], child[field]);
        if (!merged.clean)
            return merged;
        Object.assign(result, { [field]: merged.value });
    }
    for (const key of new Set([...Object.keys(base.xattrs), ...Object.keys(parent.xattrs), ...Object.keys(child.xattrs)])) {
        const merged = select(base.xattrs[key], parent.xattrs[key], child.xattrs[key]);
        if (!merged.clean)
            return merged;
        if (merged.value === undefined)
            delete result.xattrs[key];
        else
            Object.defineProperty(result.xattrs, key, { value: merged.value, enumerable: true, writable: true, configurable: true });
    }
    for (const field of ['windowsAttributes', 'bsdFlags'] as const) {
        result[field] = (base[field] ^ ((base[field] ^ parent[field]) | (base[field] ^ child[field]))) >>> 0;
    }
    // Both bodies may legitimately change mtime. The merged content receives the
    // latest selected modification, rather than turning every text merge into an
    // attribute conflict. atime and ctime are not conditional recovery state.
    const a = parent.modified, b = child.modified;
    result.modified = a.seconds > b.seconds || a.seconds === b.seconds && a.nanos >= b.nanos ? a : b;
    return { clean: true, value: result };
};
