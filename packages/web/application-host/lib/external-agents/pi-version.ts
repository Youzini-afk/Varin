/** Verified Pi 1.5.0 provides the session-settlement/disposition/delta-only contract
 * used here. Later 1.x releases are admitted by that major-version contract,
 * not claimed as tested. Older RPC has no reliable handled/settled receipt.
 * Sources: earendil-works/pi tags v1.5.0 docs/{rpc,json,rpc-commands}.md;
 * v0.60.0 src/modes/rpc/rpc-mode.ts and src/core/agent-session.ts. */
export function requirePiRpcVersion(output?: string): string {
  const versions = [
    ...(output ?? '').matchAll(
      /(?:^|\s|@)v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?=$|\s|\))/g,
    ),
  ];
  const version = versions.length === 1 ? versions[0] : undefined;
  if (!version || version[4] || Number(version[1]) !== 1 || Number(version[2]) < 5)
    throw new Error(
      'Pi RPC requires a stable Pi >=1.5.0 <2.0.0 on this execution Host. Older RPC cannot reliably distinguish handled prompts or final session settlement; unknown versions are not guessed. Update Pi with its native installation method, then reconnect.',
    );
  return `${version[1]}.${version[2]}.${version[3]}`;
}
