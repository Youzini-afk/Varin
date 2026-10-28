import path from 'node:path';
import { readFile, stat, opendir, realpath } from 'node:fs/promises';
import type { DocumentAuthority } from '../documents/authority.js';
/** Follow Git's declared administrative dependencies, not all repository files.
 * Every external directory crosses the same Documents deployment boundary. */
export async function nativeGitRoots(root: string, documents: Pick<DocumentAuthority, 'resolveWorkspace' | 'admitWorkspaceRegistration'>, signal?: AbortSignal): Promise<string[]> {
    const admitted = new Set<string>();
    const visited = new Set<string>();
    const sourceRoot = await realpath(root);
    const text = async (file: string) => {
        signal?.throwIfAborted();
        try {
            return await readFile(file, 'utf8');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw error;
        }
    };
    const admit = async (directory: string) => {
        signal?.throwIfAborted();
        const canonical = await realpath(directory);
        if (visited.has(canonical)) return null;
        visited.add(canonical);
        const relative = path.relative(sourceRoot, canonical);
        // The admitted project root already covers its own Git directories.
        // Only linked administration/alternates outside it need another root.
        if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) return canonical;
        const resolved = await documents.resolveWorkspace({ path: directory });
        const mapping = await documents.admitWorkspaceRegistration(resolved.workspaceId, signal);
        if (admitted.has(mapping.canonicalPath))
            return null;
        admitted.add(mapping.canonicalPath);
        return mapping.canonicalPath;
    };
    const objects = async (directory: string): Promise<void> => {
        const canonical = await admit(directory);
        if (!canonical)
            return;
        const alternates = await text(path.join(canonical, 'info', 'alternates'));
        if (alternates)
            for (const alternate of alternates.split(/\r?\n/).filter(Boolean))
                await objects(path.resolve(canonical, alternate));
    };
    const repository = async (directory: string) => {
        const marker = path.join(directory, '.git');
        const info = await stat(marker).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw error;
        });
        if (!info)
            return;
        let admin = marker;
        if (info.isFile()) {
            const pointer = (await text(marker))?.trim();
            if (!pointer?.startsWith('gitdir:'))
                throw new Error('The project Git administration pointer is invalid');
            admin = path.resolve(directory, pointer.slice(7).trim());
        }
        const privateRoot = await admit(admin);
        if (!privateRoot)
            return;
        const common = (await text(path.join(privateRoot, 'commondir')))?.trim();
        const commonRoot = common ? await admit(path.resolve(privateRoot, common)) : privateRoot;
        if (commonRoot && await stat(path.join(commonRoot, 'objects')).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw error;
        }))
            await objects(path.join(commonRoot, 'objects'));
    };
    // First adoption may contain several repositories or linked checkouts. Only
    // discover markers here; bodies and stability checks remain Rust's one import.
    // Never follow workspace symlinks or descend into Git administration itself.
    const pending = [root];
    while (pending.length) {
        signal?.throwIfAborted();
        const directory = pending.pop()!;
        const entries = await opendir(directory);
        for await (const entry of entries) {
            signal?.throwIfAborted();
            // The directory entry already tells us whether a Git marker exists.
            // Avoid a failing .git stat in every dependency/build directory.
            if (entry.name === '.git') await repository(directory);
            if (entry.isDirectory() && !entry.isSymbolicLink() && !['.git', '.varin'].includes(entry.name))
                pending.push(path.join(directory, entry.name));
        }
    }
    return [...admitted];
}
