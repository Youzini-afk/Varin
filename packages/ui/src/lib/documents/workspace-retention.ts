import { getRuntimeKey, type DocumentsAPI } from '@varin/application-client';
let owner: string | undefined;
const tails = new Map<string, Promise<unknown>>();
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
    if (!documents.setWorkspaceRetention)
        return Promise.resolve();
    const key = `${getRuntimeKey()}\0${workspaceId}`;
    const work = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => documents.setWorkspaceRetention!({ workspaceId, ownerId: ownerId(), retained }));
    tails.set(key, work);
    void work.finally(() => { if (tails.get(key) === work)
        tails.delete(key); }).catch(() => undefined);
    return work;
}
