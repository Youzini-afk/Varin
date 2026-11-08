import multer from 'multer';
import type { Express, RequestHandler, Response } from 'express';
import type { BotService } from './bot-service.js';
import { BotAppearanceInUseError } from './bot-appearances.js';
import { HarnessServiceError } from '../harness/service-error.js';

export function registerBotAppearanceRoutes(app: Express, bots: BotService, requireAuth: RequestHandler) {
  const fail = (res: Response, error: unknown) => res.status(error instanceof BotAppearanceInUseError ? 409
    : error instanceof HarnessServiceError ? error.harnessCode === 'not-found' ? 404 : 400 : 500)
    .json({ error: error instanceof Error ? error.message : 'Unable to load Bot appearance' });
  const base = '/api/harness/bot-appearances';
  app.get(base, requireAuth, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json({ assets: await bots.appearances.list() }); } catch (error) { fail(res, error); }
  });
  const upload = multer({ storage: multer.memoryStorage() }).single('file');
  app.post(base, requireAuth, (req, res) => {
    upload(req, res, error => {
      if (error) { res.status(400).json({ error: String(error) }); return; }
      if (!req.file) { res.status(400).json({ error: 'An image or appearance ZIP is required' }); return; }
      void bots.appearances.import(req.file.buffer, Buffer.from(req.file.originalname, 'latin1').toString('utf8'))
        .then(asset => { res.status(201).json({ asset }); }).catch(error => { fail(res, error); });
    });
  });
  app.get(`${base}/:id`, requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json({ asset: await bots.appearances.get(String(req.params.id)) }); } catch (error) { fail(res, error); }
  });
  app.delete(`${base}/:id`, requireAuth, async (req, res) => {
    try { await bots.appearances.remove(String(req.params.id)); res.json({ removed: true }); } catch (error) { fail(res, error); }
  });
  app.get(`${base}/:id/media/:hash`, requireAuth, async (req, res) => {
    try {
      const image = await bots.appearances.media(String(req.params.id), String(req.params.hash));
      res.setHeader('Content-Type', image.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.send(image.bytes);
    } catch (error) { fail(res, error); }
  });
}
