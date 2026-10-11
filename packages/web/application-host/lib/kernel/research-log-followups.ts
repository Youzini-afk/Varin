/** A transient page consumer. Catalog owns the cursor and every accepted edge. */
import { isDeepStrictEqual } from 'node:util';
import { compileLogLiteral, matchLogPage, type LogLiteralMatcher } from '../harness/experiment-log-matcher.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { ExperimentService } from '../harness/experiments.js';
import type { ExperimentCaller } from '../harness/research-identity.js';
import type { KernelClient } from './kernel-client.js';
import type { FollowupLogEvidence, FollowupLogState, FollowupResearchWork, FollowupView } from './protocol.generated.js';

export function createResearchLogReader(options: {
  kernel: KernelClient; experiments: ExperimentService; signal: AbortSignal; onAccepted: () => Promise<unknown>; onError: (error: unknown) => void;
}) {
  const matchers = new Map<string, Promise<LogLiteralMatcher>>();
  const request = options.kernel.agentRuntimeRequest.bind(options.kernel);
  const observe = async (work: FollowupResearchWork, caller: ExperimentCaller): Promise<boolean> => {
    const { source, key, binding } = work;
    if (source.kind !== 'log_literal' && source.kind !== 'log_end') throw new Error('Original log leaf changed');
    if (!work.log) throw new Error('Original log cursor is missing');
    const identity = JSON.stringify([key.ownerEpoch, key.followupId, key.generation, key.sourceIndex]);
    let cursor = work.log;
    let progressed = false;
    const publish = async (next: FollowupLogState, evidence: FollowupLogEvidence | null) => {
      options.signal.throwIfAborted();
      const result = await request<{ accepted: boolean }, 'runtime.followup.log.observe'>('runtime.followup.log.observe', { key, binding, expected: cursor, next, evidence }, options.signal);
      if (!result.accepted) { matchers.delete(identity); return false; }
      cursor = next;
      progressed = true;
      if (next.ended || next.failure_code) matchers.delete(identity);
      await options.onAccepted().catch(options.onError);
      return true;
    };
    try {
      let matcher: LogLiteralMatcher | undefined;
      if (source.kind === 'log_literal') {
        let preparing = matchers.get(identity);
        if (!preparing) {
          preparing = (async () => {
            const detail = await request<FollowupView, 'runtime.followup.get'>('runtime.followup.get', { followupId: key.followupId }, options.signal);
            const trigger = detail.registration_trigger;
            const original = trigger?.kind === 'any' || trigger?.kind === 'all' ? trigger.sources[key.sourceIndex] : key.sourceIndex === 0 ? trigger : null;
            if (!original || original.kind !== 'log_literal' || original.operationId !== source.operation_id || original.stream !== source.stream
              || (original.fromOffset ?? 0) !== source.from_offset || Buffer.byteLength(original.literal) !== source.literal_bytes
              || detail.followup.generation !== key.generation || !isDeepStrictEqual(detail.followup.trigger.kind === 'any' || detail.followup.trigger.kind === 'all'
                ? detail.followup.trigger.sources[key.sourceIndex] : detail.followup.trigger, source)) throw new Error('Original log pattern binding is unavailable');
            return compileLogLiteral(original.literal, options.signal);
          })();
          matchers.set(identity, preparing);
          void preparing.catch(() => { if (matchers.get(identity) === preparing) matchers.delete(identity); });
        }
        matcher = await preparing;
      }
      options.signal.throwIfAborted();
      const page = await options.experiments.readLogObservation(caller, binding, { stream: source.stream, offset: cursor.offset }, options.signal);
      if (page.offset !== cursor.offset || page.nextOffset !== page.offset + page.bytes.length || page.nextOffset < cursor.offset
        || (page.bytes.length > 0 && page.nextOffset > page.publishedBytes)) throw new Error('Original log reader returned an inconsistent byte range');
      if (matcher) {
        for await (const step of matchLogPage(matcher, page.bytes, page.offset, cursor.matched_prefix, options.signal)) {
          if (step.match) {
            if (page.jobRevision === null) throw new Error('Original published log Job revision is missing');
            if (!await publish({ offset: step.offset, matched_prefix: step.matchedPrefix, ended: false, failure_code: null }, {
              kind: 'log_literal', binding, stream: source.stream, start_offset: step.match.startOffset, end_offset: step.match.endOffset,
              published_bytes: page.publishedBytes, job_revision: page.jobRevision,
            })) return false;
          } else {
            const next = { offset: step.offset, matched_prefix: step.matchedPrefix, ended: page.eof, failure_code: null };
            if (!isDeepStrictEqual(next, cursor) && !await publish(next, null)) return false;
          }
        }
      } else {
        const next = { offset: page.nextOffset, matched_prefix: 0, ended: page.eof, failure_code: null };
        if (!isDeepStrictEqual(next, cursor) && !await publish(next, page.eof ? {
          kind: 'log_end', binding, stream: source.stream, published_bytes: page.publishedBytes,
          job_revision: page.jobRevision, attempt_revision: page.attemptRevision,
        } : null)) return false;
      }
      // Recheck the original projection after any commit, including a final hit
      // on a live Once source. This also prunes finished patterns without needing
      // a later domain notification. An unchanged tail causes no further scan.
      return progressed || (!cursor.ended && page.nextOffset < page.publishedBytes);
    } catch (error) {
      if (options.signal.aborted) throw error;
      const code = error instanceof HarnessServiceError && error.harnessCode === 'denied' ? 'authority_revoked' : 'source_unavailable';
      await publish({ ...cursor, failure_code: code }, null);
      throw error;
    }
  };
  return { observe, retain(identities: ReadonlySet<string>) {
    for (const key of matchers.keys()) if (!identities.has(key)) matchers.delete(key);
  } };
}
