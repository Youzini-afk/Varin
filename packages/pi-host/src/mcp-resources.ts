/** Narrow resource observer shapes. The original McpAuthority owns all clients and URI holders. */
import type { McpEndpoint } from '@varin/protocol';
export type McpResourceChange = {
    kind: 'updated';
    notification: Record<string, unknown>;
} | {
    kind: 'unresolved_association';
} | {
    kind: 'gap';
} | {
    kind: 'unavailable';
    problem: string;
};
export type McpResourceCleanup = 'shared' | 'acknowledged' | 'unknown';
export type McpResourceRelease = { status: 'acknowledged'; acknowledgement: Record<string, unknown> } | { status: 'shared' | 'unknown' };
export interface McpResourceObserver {
    readonly endpoint: McpEndpoint;
    readonly listenerId: string;
    readonly acknowledgement: Record<string, unknown>;
    /** Synchronously fences/removes this holder. Remote cleanup is a separate bounded request. */
    detach(): Promise<McpResourceRelease>;
}
