import { getRuntimeKey, type DocumentsAPI } from '@varin/application-client';
let owner: string | undefined;
const apiKeys = new WeakMap<DocumentsAPI, number>();
let nextApiKey = 0;
function retentionKey(documents: DocumentsAPI, workspaceId: string): string {
    let id = apiKeys.get(documents);
    if (id === undefined) { id = ++nextApiKey; apiKeys.set(documents, id); }
    return `${getRuntimeKey()}\0${id}\0${workspaceId}`;
}
const tails = new Map<string, Promise<unknown>>();
const visibleViews = new Map<string, number>();
const savedTabs = new Map<string, boolean>();
function ownerId(): string {
    if (owner)
        return owner;
    const key = 'varin.editor-workbench.owner';
    try {
        owner = localStorage.getItem(key) || crypto.randomUUID();
        localStorage.setItem(key, owner);
    }
    catch {
        owner = crypto.randomUUID();
    }
    return owner;
}
/** Saved tabs retain their actual Host source across reloads and app shutdown.
 * Closing the last tab releases that reference; dirty journals retain themselves. */
export function retainEditorWorkspace(documents: DocumentsAPI, workspaceId: string, retained: boolean): Promise<unknown> {
    const key = retentionKey(documents, workspaceId);
    if (retained) savedTabs.set(key, true);
    else savedTabs.delete(key);
    return publishRetention(documents, workspaceId, key);
}
/** Independent file views share source lifetime with saved editor tabs, not their navigation. */
export function holdEditorWorkspace(documents: DocumentsAPI, workspaceId: string): () => Promise<unknown> {
    const key = retentionKey(documents, workspaceId);
    visibleViews.set(key, (visibleViews.get(key) ?? 0) + 1);
    void publishRetention(documents, workspaceId, key).catch(error => console.error('[Documents] File view retention failed:', error));
    return () => {
        const count = (visibleViews.get(key) ?? 1) - 1;
        if (count) visibleViews.set(key, count);
        else visibleViews.delete(key);
        return publishRetention(documents, workspaceId, key);
    };
}
function publishRetention(documents: DocumentsAPI, workspaceId: string, key: string): Promise<unknown> {
    if (!documents.setWorkspaceRetention) return Promise.resolve();
    const work = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => documents.setWorkspaceRetention!({ workspaceId, ownerId: ownerId(), retained: Boolean(savedTabs.get(key) || visibleViews.get(key)) }));
    tails.set(key, work);
    void work.finally(() => { if (tails.get(key) === work)
        tails.delete(key); }).catch(() => undefined);
    return work;
}
