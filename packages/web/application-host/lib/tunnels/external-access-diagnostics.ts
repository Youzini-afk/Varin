import type { ExternalAccessCheck } from '@varin/application-client';
import { inspectPublicEndpoint } from '../platform/external-endpoint-proof.js';
import type { createPublicIngress } from '../platform/public-ingress.js';
import { ExternalAccessRuntimeError } from './external-access-runtime.js';

type DiagnosticIngress = Pick<ReturnType<typeof createPublicIngress>, 'enabled' | 'configuration' | 'issueEndpointProof'>;

/** User-invoked proof of the live generation; never owns ingress, settings, or recovery. */
export function createExternalAccessDiagnostics(
  getIngress: () => DiagnosticIngress | null,
  inspect = inspectPublicEndpoint,
) {
  let last: { ingress: DiagnosticIngress; result: ExternalAccessCheck } | undefined;
  let pending: { ingress: DiagnosticIngress; abort: AbortController; work: Promise<void> } | undefined;
  const current = () => {
    const ingress = getIngress();
    return ingress?.enabled ? ingress : null;
  };
  return {
    getLastCheck(): ExternalAccessCheck | undefined {
      return last && last.ingress === current() ? { ...last.result } : undefined;
    },
    check(): Promise<void> {
      const ingress = current();
      if (!ingress) return Promise.reject(new ExternalAccessRuntimeError('not_enabled'));
      if (pending?.ingress === ingress) return pending.work;
      pending?.abort.abort();
      const abort = new AbortController();
      const challenge = ingress.issueEndpointProof();
      const origin = ingress.configuration.origin;
      const work = Promise.resolve().then(async () => {
        try {
          const outcome = await inspect({ origin, challenge, signal: abort.signal });
          if (abort.signal.aborted || current() !== ingress) return;
          last = { ingress, result: { origin, checkedAt: Date.now(),
            ...(outcome === 'verified' ? { state: 'verified' } : { state: 'unverified', reason: outcome }) } };
        } finally {
          challenge.clear();
          if (pending?.abort === abort) pending = undefined;
        }
      });
      pending = { ingress, abort, work };
      return work;
    },
  };
}
