import express from 'express';
import supertest from 'supertest';
import { expect, it, vi } from 'vitest';
import { DeploymentSshError, type DeploymentSshInspection } from '../connections/deployment-ssh.js';
import { registerDeploymentPreviewRoute } from './deployment-preview-routes.js';

const url = '/api/varin/external-access/deployment/preview';
const hostKeyFingerprint = `SHA256:${'B'.repeat(43)}`;
const target = { sshTargetId: 'saved-vps', hostKeyFingerprint };
const session = { ...target, sessionId: 'session-not-in-output' };
const spec = {
  deploymentId: 'home-vps', sshTargetId: target.sshTargetId, publicOrigin: 'https://varin.example.test',
  https: { kind: 'caddy' },
  frp: {
    controlPort: 7000, remotePort: 7300, tokenRef: 'VARIN_FRP_TOKEN_HOME',
    tls: { certificateFile: '/etc/ssl/server.pem', privateKeyFile: '/etc/ssl/server.key', serverName: 'frps.example.test', caSha256: 'e'.repeat(64) },
  },
};

function createFixture() {
  const openSession = vi.fn(async () => session);
  const inspect = vi.fn(async (): Promise<DeploymentSshInspection> => ({
    target,
    platform: { id: 'debian', version: '12', kernel: 'Linux', systemd: true, systemdVersion: 252 },
    privileged: true, inventoryComplete: true, prerequisites: { python: true },
    files: [], listeners: [], services: [],
    ownership: { status: 'present', manifest: { extra: 'not-in-preview' } },
  }));
  const closeSession = vi.fn(async () => undefined);
  const app = express();
  registerDeploymentPreviewRoute(app, {
    json: express.json(),
    authorize: req => req.headers['x-mock-local-owner'] === 'true',
    transport: { openSession, inspect, closeSession },
  });
  const call = (request = spec) => supertest(app).post(url).set('x-mock-local-owner', 'true').send(request);
  return { app, call, openSession, inspect, closeSession };
}

it('does not contact a saved target for unauthorized or invalid inspection requests', async () => {
  const f = createFixture();
  await supertest(f.app).post(url).send(spec).expect(403);
  await f.call({ ...spec, publicOrigin: 'http://wrong.example.test' }).expect(400);
  expect(f.openSession).not.toHaveBeenCalled();
});

it('uses verified SSH identity and fixed inspection shape, never caller-asserted evidence', async () => {
  const f = createFixture();
  const response = await f.call(Object.assign({}, spec, { evidence: { dnsPointsToTarget: true, certificates: [] } })).expect(200);
  expect(f.openSession).toHaveBeenCalledExactlyOnceWith('saved-vps');
  expect(f.inspect).toHaveBeenCalledExactlyOnceWith(session, expect.objectContaining({
    ports: [80, 443, 7000, 7300], ownershipPath: expect.stringContaining('/home-vps/manifest.json'),
  }));
  expect(response.body).toMatchObject({ target, mode: 'preview-only', mayApply: false, planId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(response.body.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'incomplete_evidence' })]));
  expect(response.text).not.toContain('not-in-preview');
  expect(response.text).not.toContain('session-not-in-output');
  expect(response.text).not.toContain('VARIN_FRP_TOKEN_HOME');
  expect(f.closeSession).toHaveBeenCalledExactlyOnceWith(session);
});

it('does not inspect when the accepted target key has changed', async () => {
  const f = createFixture();
  await f.call(Object.assign({}, spec, { expectedHostKeyFingerprint: `SHA256:${'C'.repeat(43)}` })).expect(409);
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.closeSession).toHaveBeenCalledExactlyOnceWith(session);
});

it('pauses for an unknown host key and does not accept or disclose raw diagnostics', async () => {
  const f = createFixture();
  f.openSession.mockRejectedValueOnce(new DeploymentSshError('host_key_verification_required'));
  const response = await f.call().expect(409);
  expect(response.body.code).toBe('host_key_verification_required');
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.closeSession).not.toHaveBeenCalled();
});
