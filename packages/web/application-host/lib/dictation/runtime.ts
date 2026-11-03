/**
 * Dictation runtime: registers the streaming dictation WebSocket endpoint and
 * the HTTP status/model routes.
 *
 * WebSocket protocol (JSON text frames) on /api/dictation/ws:
 *   client -> server:
 *     { type: 'start',  dictationId, format, options? }
 *       options: { provider?, language?, localModel?, openaiCompatible? }
 *     { type: 'chunk',  dictationId, seq, audio }   // audio: base64 PCM16LE
 *     { type: 'finish', dictationId, finalSeq }
 *     { type: 'cancel', dictationId }
 *     { type: 'ping' }
 *   server -> client:
 *     { type: 'ready' }
 *     { type: 'ack',             dictationId, ackSeq }
 *     { type: 'partial',         dictationId, text }
 *     { type: 'finish_accepted', dictationId, timeoutMs }
 *     { type: 'final',           dictationId, text }
 *     { type: 'error',           dictationId, error, retryable, reasonCode? }
 *     { type: 'pong' }
 */

import { WebSocketServer } from 'ws';

import { DictationStreamManager } from './stream-manager.js';
import { createDictationService } from './service.js';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DictationStartOptions } from './types.js';

const DICTATION_WS_PATH = '/api/dictation/ws';

const DICTATION_WS_MAX_PAYLOAD_BYTES = 512 * 1024;
const DICTATION_WS_HEARTBEAT_INTERVAL_MS = 30000;

interface DictationUiAuthController {
  authenticationRequired?: boolean;
  ensureSessionToken?: (request: IncomingMessage, response: null) => Promise<string | null>;
}

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error ? error.message : fallback
);

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const parseStartOptions = (value: unknown): DictationStartOptions => {
  const options = asRecord(value);
  const compatible = asRecord(options.openaiCompatible);
  return {
    ...(typeof options.provider === 'string' ? { provider: options.provider } : {}),
    ...(typeof options.language === 'string' ? { language: options.language } : {}),
    ...(typeof options.localModel === 'string' ? { localModel: options.localModel } : {}),
    ...(Object.keys(compatible).length > 0 ? {
      openaiCompatible: {
        ...(typeof compatible.baseUrl === 'string' ? { baseUrl: compatible.baseUrl } : {}),
        ...(typeof compatible.model === 'string' ? { model: compatible.model } : {}),
        ...(typeof compatible.apiKey === 'string' ? { apiKey: compatible.apiKey } : {}),
      },
    } : {}),
  };
};

const parseRequestPathname = (url: string | undefined): string => {
  try {
    return new URL(url ?? '', 'http://localhost').pathname;
  } catch {
    return typeof url === 'string' ? (url.split('?')[0] ?? '') : '';
  }
};

export function createDictationRuntime({
  app,
  server,
  express,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  modelsDir,
}: {
  app: Express;
  express: { json(options?: { limit?: string }): import('express').RequestHandler };
  isRequestOriginAllowed: (request: IncomingMessage) => boolean | Promise<boolean>;
  modelsDir: string;
  rejectWebSocketUpgrade: (socket: Duplex, statusCode: number, message: string) => void;
  server: Server;
  uiAuthController?: DictationUiAuthController;
}) {
  const service = createDictationService({ modelsDir });

  // Local text-to-speech (Kokoro in the dictation worker). Returns WAV bytes;
  // 503 with a reason code while the model is still downloading.
  app.post('/api/dictation/tts/speak', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const body = asRecord(req.body);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) {
        res.status(400).json({ error: 'Text is required' });
        return;
      }
      const result = await service.synthesizeSpeech({
        text,
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        ...(typeof body.speakerId === 'number' && Number.isInteger(body.speakerId) ? { speakerId: body.speakerId } : {}),
        ...(typeof body.speed === 'number' ? { speed: body.speed } : {}),
      });
      if ('error' in result) {
        res.status(503).json({
          error: result.error,
          retryable: result.retryable !== false,
          ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
        });
        return;
      }
      res.setHeader('Content-Type', result.format || 'audio/wav');
      res.send(result.audio);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error, 'Failed to synthesize speech') });
    }
  });

  app.get('/api/dictation/status', async (req, res) => {
    try {
      const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
      const localModel = typeof req.query.localModel === 'string' ? req.query.localModel : undefined;
      const status = await service.getStatus({
        ...(provider ? { provider } : {}),
        ...(localModel ? { localModel } : {}),
      });
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error, 'Failed to read dictation status') });
    }
  });

  app.post('/api/dictation/models/:modelId/download', async (req, res) => {
    try {
      const result = await service.requestModelDownload(req.params.modelId);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error, 'Failed to start model download') });
    }
  });

  app.delete('/api/dictation/models/:modelId', async (req, res) => {
    try {
      const result = await service.deleteModel(req.params.modelId);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: errorMessage(error, 'Failed to delete model') });
    }
  });

  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: DICTATION_WS_MAX_PAYLOAD_BYTES,
  });

  wsServer.on('connection', (socket) => {
    const send = (msg: Record<string, unknown>): void => {
      if (socket.readyState !== 1) {
        return;
      }
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        // socket is going away; the manager cleanup on close handles state
      }
    };

    const manager = new DictationStreamManager({
      emit: ({ type, payload }) => send({ type, ...payload }),
      createSttSession: (options) => service.createSttSession(options),
    });

    send({ type: 'ready' });

    const heartbeatInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }
      try {
        socket.ping();
      } catch {
        // ignore
      }
    }, DICTATION_WS_HEARTBEAT_INTERVAL_MS);

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = asRecord(JSON.parse(raw.toString('utf8')));
      } catch {
        return;
      }
      switch (message.type) {
        case 'start': {
          if (typeof message.dictationId !== 'string' || typeof message.format !== 'string') {
            return;
          }
          const options = parseStartOptions(message.options);
          void manager.handleStart(message.dictationId, message.format, options);
          return;
        }
        case 'chunk': {
          if (
            typeof message.dictationId !== 'string' ||
            typeof message.seq !== 'number' ||
            typeof message.audio !== 'string'
          ) {
            return;
          }
          manager.handleChunk({
            dictationId: message.dictationId,
            seq: message.seq,
            audioBase64: message.audio,
          });
          return;
        }
        case 'finish': {
          if (typeof message.dictationId !== 'string' || typeof message.finalSeq !== 'number') {
            return;
          }
          manager.handleFinish(message.dictationId, message.finalSeq);
          return;
        }
        case 'cancel': {
          if (typeof message.dictationId !== 'string') {
            return;
          }
          manager.handleCancel(message.dictationId);
          return;
        }
        case 'ping': {
          send({ type: 'pong' });
          return;
        }
        default:
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeatInterval);
      manager.cleanupAll();
    });

    socket.on('error', () => {
      // 'close' follows and performs cleanup.
    });
  });

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== DICTATION_WS_PATH) {
      return;
    }

    const handleUpgrade = async () => {
      try {
        if (uiAuthController?.authenticationRequired) {
          const sessionToken = await uiAuthController?.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
            return;
          }
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };

    void handleUpgrade();
  };

  server.on('upgrade', upgradeHandler);

  const stop = (): void => {
    server.off('upgrade', upgradeHandler);
    for (const client of wsServer.clients) {
      try {
        client.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
    }
    try {
      wsServer.close();
    } catch {
      // ignore
    }
    service.shutdown();
  };

  return { stop };
}
