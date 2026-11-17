export const kitFiles: readonly string[];
export const kitArchivePath: string;
export const kitDownloadPaths: readonly string[];
export function buildExternalAccessDownloads(root: string, requestedPath?: string): Promise<Map<string, Buffer>>;
