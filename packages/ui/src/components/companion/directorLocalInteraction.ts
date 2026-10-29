/** Local attention is presentation only: it never acknowledges a project request
 * or consumes a management edge. Finite handovers retain their authored contact. */
export function directorLocalResponse(input: {
  event: 'tap' | 'hover'; current: boolean; visible: boolean; interacting: boolean;
  blockedUI: boolean; finiteHandover: boolean; closed: boolean;
}): 'tap-response' | 'hover-response' | 'director-open-attention' | null {
  if (!input.current || !input.visible || input.interacting || input.blockedUI || input.finiteHandover) return null;
  if (input.event === 'tap') return input.closed ? 'tap-response' : 'director-open-attention';
  return input.closed ? 'hover-response' : 'director-open-attention';
}
