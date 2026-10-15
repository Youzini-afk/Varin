/**
 * Client-surface bridge (Stage S / D-309): targeted reads and applies of
 * device-local settings on connected UI surfaces.
 *
 * A surface identifies itself when it opens `/api/varin/events` with
 * `?surface=<id>&kind=<kind>&threadId=<thread>&branchId=<branch>`, after an authenticated
 * bind operation. Host-side writes never guess the client identity — the
 * Thread/branch binding selects the connection, and applies land only on
 * connections that declared that identity. The surface acknowledges over
 * `POST /api/varin/client-settings/ack`; the request resolves with the
 * surface-reported facts (saved/applied/failed), never an assumed success.
 */

import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { HarnessServiceError } from './service-error.js';
import type {
  ClientSurfaceBridge,
  ClientSurfaceFieldResult,
  ClientSurfaceInfo,
  SettingsServiceCaller,
} from './settings-service.js';

/**
 * Bound on a surface round-trip: SSE delivery plus a synchronous local store
 * write is millisecond-scale, so a request that outlives this window means the
 * connection died between send and ack — resolve it as unavailable rather than
 * leaking the pending tool call forever.
 */
const SURFACE_REQUEST_TIMEOUT_MS = 15_000;

interface SurfaceConnection {
  authKey: string;
  connectionId: string;
  res: Response;
  surfaceId: string;
  kind: string;
  /** Host-validated native Catalog selection. */
  identity: ThreadSelection;
}

interface PendingRequest {
  authKey: string;
  connectionIds: Set<string>;
  resolve: (value: { surface: ClientSurfaceInfo; results: ClientSurfaceFieldResult[] }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  surface: ClientSurfaceInfo;
}

export type ThreadSelection = Pick<SettingsServiceCaller, 'threadId' | 'branchId'>;
const selectionKey = (identity: ThreadSelection): string => JSON.stringify([identity.threadId, identity.branchId]);
const sameSelection = (a: ThreadSelection, b: ThreadSelection): boolean => selectionKey(a) === selectionKey(b);

export interface SurfaceBridgeDeps {
  writeSseEvent(res: Response, event: { type: string; properties: Record<string, unknown> }): void;
  /** Native Catalog identity check; stale connections are evicted before a request. */
  isThreadLive?(identity: ThreadSelection): boolean | Promise<boolean>;
}

export function createClientSurfaceBridge({ writeSseEvent, isThreadLive }: SurfaceBridgeDeps) {
  const connections = new Map<Response, SurfaceConnection>();
  const pending = new Map<string, PendingRequest>();

  const attach = (
    res: Response,
    surfaceId: string,
    kind: string,
    authKey: string,
    identity: ThreadSelection,
  ) => {
    connections.set(res, {
      authKey,
      connectionId: randomUUID(),
      res,
      surfaceId,
      kind,
      identity: { ...identity },
    });
  };

  // A successful authenticated bind replaces this Surface's previous selection.
  // The opaque principal and one-use permit are Host state, never renderer authority.
  const bindings = new Map<string, Map<string, string>>();
  const bindThread = (authKey: string, identity: ThreadSelection, surfaceId: string): void => {
    const surfaces = bindings.get(authKey) ?? new Map<string, string>();
    surfaces.set(surfaceId, selectionKey(identity));
    bindings.set(authKey, surfaces);
    for (const [res, connection] of connections) {
      if (connection.authKey === authKey && connection.surfaceId === surfaceId) dropConnection(res);
    }
  };
  const consumeThreadBinding = (authKey: string, identity: ThreadSelection, surfaceId: string): boolean => {
    const surfaces = bindings.get(authKey);
    if (surfaces?.get(surfaceId) !== selectionKey(identity)) return false;
    surfaces.delete(surfaceId);
    if (surfaces.size === 0) bindings.delete(authKey);
    return true;
  };
  const dropThread = (identity: ThreadSelection): void => {
    for (const [authKey, surfaces] of bindings) {
      for (const [surfaceId, key] of surfaces) if (key === selectionKey(identity)) surfaces.delete(surfaceId);
      if (surfaces.size === 0) bindings.delete(authKey);
    }
    for (const [res, connection] of connections) if (sameSelection(connection.identity, identity)) dropConnection(res);
  };

  const detach = (res: Response) => {
    connections.delete(res);
  };

  /** Distinct authenticated surfaces for Host-side capability/status hints. */
  const list = (): ClientSurfaceInfo[] => {
    const seen = new Map<string, ClientSurfaceInfo>();
    for (const conn of connections.values()) {
      const identity = `${conn.authKey}\0${conn.surfaceId}`;
      if (!seen.has(identity)) seen.set(identity, { id: conn.surfaceId, kind: conn.kind });
    }
    return [...seen.values()];
  };

  const listForThread = (selection: ThreadSelection): ClientSurfaceInfo[] => {
    const seen = new Map<string, ClientSurfaceInfo>();
    for (const conn of connections.values()) {
      if (!sameSelection(conn.identity, selection)) continue;
      const identity = `${conn.authKey}\0${conn.surfaceId}`;
      if (!seen.has(identity)) seen.set(identity, { id: conn.surfaceId, kind: conn.kind });
    }
    return [...seen.values()];
  };

  const failPending = (connection: SurfaceConnection, error: Error) => {
    for (const [id, request] of pending) {
      if (request.surface.id !== connection.surfaceId || request.authKey !== connection.authKey) continue;
      request.connectionIds.delete(connection.connectionId);
      if (request.connectionIds.size > 0) continue;
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error);
    }
  };

  const request: ClientSurfaceBridge['request'] = async (op, target) => {
    if (isThreadLive && !(await isThreadLive(target))) {
      dropThread(target);
      throw new HarnessServiceError(
        'unavailable',
        `Thread ${target.threadId}/${target.branchId} is unavailable on this Host`,
      );
    }
    const targets = [...connections.values()];
    const threadTargets = targets.filter((conn) => sameSelection(conn.identity, target));
    const targetSurfaces = new Map<string, ClientSurfaceInfo>();
    for (const conn of threadTargets) {
      const identity = `${conn.authKey}\0${conn.surfaceId}`;
      if (!targetSurfaces.has(identity)) targetSurfaces.set(identity, { id: conn.surfaceId, kind: conn.kind });
    }
    const surfaces = [...targetSurfaces.values()];
    if (surfaces.length === 0) {
      throw new HarnessServiceError(
        'unavailable',
        `no authenticated surface is bound to Thread ${target.threadId}/${target.branchId}`,
      );
    }
    if (surfaces.length > 1) {
      throw new HarnessServiceError(
        'ambiguous',
        `${surfaces.length} authenticated surfaces are connected (${surfaces.map((s) => `${s.kind}:${s.id.slice(0, 8)}`).join(', ')})`,
      );
    }
    const surface = surfaces[0]!;
    const targetIdentity = threadTargets.find((conn) => conn.surfaceId === surface.id)!;
    const selectedTargets = targets.filter((conn) => (
      conn.surfaceId === surface.id
      && conn.authKey === targetIdentity.authKey
      && sameSelection(conn.identity, targetIdentity.identity)
    ));
    const requestId = `surface-${randomUUID()}`;
    const results = new Promise<{ surface: ClientSurfaceInfo; results: ClientSurfaceFieldResult[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new HarnessServiceError(
          'unavailable',
          `surface ${surface.id} did not acknowledge within ${SURFACE_REQUEST_TIMEOUT_MS}ms — connection may have dropped`,
        ));
      }, SURFACE_REQUEST_TIMEOUT_MS);
      pending.set(requestId, {
        authKey: targetIdentity.authKey,
        connectionIds: new Set(selectedTargets.map((target) => target.connectionId)),
        resolve,
        reject,
        timer,
        surface,
      });
    });
    try {
      for (const conn of selectedTargets) {
        writeSseEvent(conn.res, {
          type: 'varin:client-settings-request',
          properties: {
            requestId,
            connectionId: conn.connectionId,
            surfaceId: conn.surfaceId,
            op: op.type,
            entries: op.entries,
          },
        });
      }
    } catch (error) {
      const request = pending.get(requestId);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(requestId);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    return results;
  };

  /** The surface reports the real per-entry outcome. */
  const ack = (
    requestId: string,
    surfaceId: string,
    connectionId: string,
    authKey: string,
    results: ClientSurfaceFieldResult[],
  ) => {
    const request = pending.get(requestId);
    if (!request) return false;
    if (request.surface.id !== surfaceId
      || request.authKey !== authKey
      || !request.connectionIds.has(connectionId)) return false;
    clearTimeout(request.timer);
    pending.delete(requestId);
    request.resolve({ surface: request.surface, results });
    return true;
  };

  /** Connection teardown fails its in-flight requests honestly. */
  const dropConnection = (res: Response) => {
    const conn = connections.get(res);
    detach(res);
    if (!conn) return;
    const stillConnected = [...connections.values()].some((other) => (
      other.surfaceId === conn.surfaceId && other.authKey === conn.authKey
    ));
    if (!stillConnected) {
      failPending(conn, new HarnessServiceError(
        'unavailable',
        `surface ${conn.surfaceId} disconnected before acknowledging`,
      ));
    } else {
      failPending(conn, new HarnessServiceError(
        'unavailable',
        `surface connection ${conn.connectionId} disconnected before acknowledging`,
      ));
    }
  };

  return {
    attach,
    bindThread,
    consumeThreadBinding,
    dropThread,
    detach,
    dropConnection,
    list,
    listForThread,
    request,
    ack,
    /** Testing/inspection: number of in-flight requests. */
    pendingCount: () => pending.size,
  };
}

export type ClientSurfaceBridgeHandle = ReturnType<typeof createClientSurfaceBridge>;
