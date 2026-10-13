/** Narrow resource observer shapes. The original McpAuthority owns all clients and URI holders. */
import type { McpInteractionOrigin } from './mcp-authority.js';
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
export type McpResourceRelease = { status: 'acknowledged'; acknowledgement: Record<string, unknown> } | { status: 'shared' | 'unknown'; protocolError?: Record<string, unknown>; interactionProblem?: string };
export interface McpResourceObserver {
    readonly endpoint: McpEndpoint;
    readonly listenerId: string;
    readonly acknowledgement: Record<string, unknown>;
    /** Detach only a remote projection; the original target holder remains recoverable. */
    disconnect?(): void;
    /** Synchronously fences/removes this holder. Remote cleanup is a separate bounded request. */
    detach(options?: { interaction: McpInteractionOrigin; signal: AbortSignal }): Promise<McpResourceRelease>;
}
