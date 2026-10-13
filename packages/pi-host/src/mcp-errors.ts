/** A pre-dispatch rejection is safe to record as no effect; an entered transport is uncertain. */
export class McpAuthorityError extends Error {
  constructor(readonly code: string, readonly dispatched = false,
    readonly settlement: 'unknown' | 'session_expired' | 'rpc_response' = 'unknown', readonly protocolError?: Record<string, unknown>, readonly interactionProblem?: string) { super(code); this.name = 'McpAuthorityError'; }
}
export class McpTaskRequestError extends McpAuthorityError {
  constructor(code:string, dispatched:boolean, readonly kind:'protocol'|'transport'|'unsupported'|'owner',
    readonly rpcCode?:number, override readonly protocolError?:Record<string,unknown>, settlement:'unknown'|'session_expired'|'rpc_response'='unknown', interactionProblem?:string) { super(code,dispatched,settlement,protocolError,interactionProblem); }
}
