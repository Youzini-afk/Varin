import type { Express, NextFunction, Request, Response } from 'express';
import { DeploymentSshError, type DeploymentSshInspection, type DeploymentSshTransport } from '../connections/deployment-ssh.js';
import {
  createSelfHostedDeploymentPlan,
  selfHostedDeploymentInspectionQuery,
  type DeploymentPathEvidence,
  type DeploymentPreflightEvidence,
  type SelfHostedDeploymentRequest,
} from './deployment-plan.js';

const path = '/api/varin/external-access/deployment/preview';
const savedTarget = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u;
const fingerprint = /^SHA256:[A-Za-z0-9+/]{43}=?$/u;

type Transport = Pick<DeploymentSshTransport, 'openSession' | 'inspect' | 'closeSession'>;

function initialEvidence(raw: DeploymentSshInspection, query: ReturnType<typeof selfHostedDeploymentInspectionQuery>): DeploymentPreflightEvidence {
  const paths: Record<string, DeploymentPathEvidence> = {};
  for (const file of raw.files) {
    if (!query.files.includes(file.path)) continue;
    const safeAncestors = file.trustedParent === true;
    paths[file.path] = file.kind === 'missing' ? { kind: 'missing', safeAncestors } : {
      kind: file.kind, uid: file.uid ?? -1, safeAncestors, ...(file.sha256 ? { sha256: file.sha256 } : {}),
    };
  }
  return {
    target: raw.target,
    platform: { id: raw.platform.id, systemd: raw.platform.systemd, systemdVersion: raw.platform.systemdVersion ?? 0 },
    privileged: raw.privileged,
    // Structural inspection is not evidence of component provenance/version,
    // active proxy compatibility, CA/renewal ownership, DNS, or a firewall.
    // Those checks must be verified by a future owner; a browser cannot assert them.
    inventoryComplete: false,
    paths,
    listeners: raw.listeners,
    components: [],
    sites: [],
    services: [],
    certificates: [],
    dnsPointsToTarget: false,
    reachability: query.ports.map(port => ({ port, protocol: 'tcp', state: 'unknown' })),
  };
}

export function registerDeploymentPreviewRoute(app: Express, options: {
  json: ReturnType<typeof import('express').json>;
  authorize(request: Request): Promise<boolean> | boolean;
  transport: Transport;
}) {
  let busy = false;
  app.post(path, options.json, async (request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!await options.authorize(request)) {
      response.status(403).json({ error: 'Preview a server from the local Host settings.' });
      return;
    }

    const body = request.body as Partial<SelfHostedDeploymentRequest> & {
      sshTargetId?: unknown;
      expectedHostKeyFingerprint?: unknown;
    } | null;
    const id = body?.sshTargetId;
    const expected = body?.expectedHostKeyFingerprint;
    if (typeof id !== 'string' || !savedTarget.test(id) ||
      (expected !== undefined && (typeof expected !== 'string' || !fingerprint.test(expected)))) {
      response.status(400).json({ error: 'Choose an existing saved SSH connection.' });
      return;
    }
    // Validate a complete, fixed inspection shape before opening any connection.
    // This provisional fingerprint is replaced by the accepted actual host key,
    // and cannot be used as trust evidence or returned to the client.
    const input = { ...body, target: { sshTargetId: id, hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` } } as SelfHostedDeploymentRequest;
    let query: ReturnType<typeof selfHostedDeploymentInspectionQuery>;
    try { query = selfHostedDeploymentInspectionQuery(input); }
    catch { response.status(400).json({ error: 'Invalid deployment configuration.' }); return; }

    if (busy) {
      response.status(409).json({ error: 'The Host is already inspecting a server.' });
      return;
    }

    busy = true;
    let session: Awaited<ReturnType<Transport['openSession']>> | undefined;
    try {
      session = await options.transport.openSession(id);
      if (session.sshTargetId !== id || (expected !== undefined && session.hostKeyFingerprint !== expected)) {
        response.status(409).json({ code: 'target_changed', error: 'The accepted Host key no longer matches the previous preview.' });
        return;
      }
      const observed = await options.transport.inspect(session, query);
      const plan = createSelfHostedDeploymentPlan({ ...input, target: session }, initialEvidence(observed, query));
      response.json({
        mode: 'preview-only',
        mayApply: false,
        planId: plan.id,
        target: plan.target,
        publicOrigin: plan.publicOrigin,
        blockers: plan.blockers,
        steps: plan.steps,
        requiredPorts: plan.requiredPorts,
        preview: plan.preview,
      });
    } catch (error) {
      if (error instanceof DeploymentSshError) {
        response.status(error.code === 'host_key_verification_required' || error.code === 'target_changed' ? 409 : 503)
          .json({ code: error.code, error: 'Server inspection stopped without applying changes. Check the existing SSH connection.' });
      } else {
        next(error);
      }
    } finally {
      try { if (session) await options.transport.closeSession(session); }
      finally { busy = false; }
    }
  });
}
