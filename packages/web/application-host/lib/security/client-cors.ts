import type { RequestHandler } from 'express';
import { isPackagedClientOrigin } from './client-origins.js';

/** Browser transport permission only. Route authentication remains unchanged. */
export const clientCors: RequestHandler = (req, res, next) => {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (isPackagedClientOrigin(origin) || origin === 'http://localhost' || /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-Varin-Application-Token,X-Varin-Directory,X-Varin-Directory-Encoding');
    res.setHeader('Access-Control-Expose-Headers', 'x-next-cursor');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
  }
  next();
};
