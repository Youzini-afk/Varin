const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

export const getPatchText = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
        return /\S/.test(value) ? value : undefined;
    }

    if (isRecord(value)) {
        const patch = value.patch;
        if (typeof patch === 'string') {
            return /\S/.test(patch) ? patch : undefined;
        }
    }

    return undefined;
};

export const getApplyPatchFilePath = (file: unknown): string | null => {
    if (!isRecord(file)) return null;
    return typeof file.movePath === 'string'
        ? file.movePath
        : typeof file.moveTo === 'string'
            ? file.moveTo
            : typeof file.filePath === 'string'
                ? file.filePath
                : typeof file.path === 'string'
                    ? file.path
                    : typeof file.relativePath === 'string'
                        ? file.relativePath
                        : null;
};

export const getApplyPatchFileEntries = (details: unknown): Array<{
    deleted: boolean;
    filePath: string;
    patch?: string;
}> => {
    if (!isRecord(details)) return [];
    const source = Array.isArray(details.files)
        ? details.files
        : Array.isArray(details.changes)
            ? details.changes
            : [];
    return source.flatMap((file) => {
        if (!isRecord(file)) return [];
        const filePath = getApplyPatchFilePath(file);
        if (!filePath) return [];
        return [{
            deleted: file.type === 'delete' || file.kind === 'delete',
            filePath,
            patch: getPatchText(file.patch) ?? getPatchText(file.diff) ?? getPatchText(file.displayDiff),
        }];
    });
};
