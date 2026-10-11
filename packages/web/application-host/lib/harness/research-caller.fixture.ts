/** Explicit Pi test caller. It never supplies native identity or maintenance authority. */
import type { ExperimentCaller } from './research-identity.js';
export function piResearchCaller(input: {workspaceId:string; executionWorkspaceId:string; sessionId?:string|undefined; rootSessionId?:string|undefined; threadId?:string|undefined; runId?:string|undefined; workspaceScope?:readonly string[]; allowedThreadIds?:readonly string[]}):ExperimentCaller {
  const sessionId=input.sessionId??'fixture-session';
  const ids=input.allowedThreadIds??(input.threadId?[input.threadId]:[]);
  return {...input,sessionId,rootSessionId:input.rootSessionId??sessionId,
    owner:{runtime:'pi',rootSessionId:input.rootSessionId??sessionId,sessionId,...(input.threadId?{threadId:input.threadId}:{}),...(input.runId?{runId:input.runId}:{})},
    access:{kind:'family',readThreadIds:ids,controlThreadIds:ids}};
}
