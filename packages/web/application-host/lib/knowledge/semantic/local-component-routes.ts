import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express, RequestHandler } from "express";
import multer from "multer";
import type { LocalSemanticComponentManager } from "./local-component.js";

export interface LocalSemanticComponentRoutesOptions {
  manager: LocalSemanticComponentManager;
  requireAuth?: RequestHandler;
}

const noAuth: RequestHandler = (_request, _response, next) => next();

export const registerLocalSemanticComponentRoutes = (
  app: Express,
  { manager, requireAuth = noAuth }: LocalSemanticComponentRoutesOptions,
): void => {
  const uploadRoot = join(tmpdir(), "varin-local-semantic-imports");
  mkdirSync(uploadRoot, { recursive: true });
  const multipart = multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, uploadRoot),
    filename: (_request, file, callback) => callback(null, `${randomUUID()}-${(file.originalname || "component.tar.gz").replace(/[\\/]/gu, "_")}`),
  });
  const upload = multer({ storage: multipart });

  app.get("/api/harness/local-semantic", requireAuth, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(manager.status());
  });

  app.post("/api/harness/local-semantic/install", requireAuth, async (_request, response, next) => {
    try {
      void manager.install().catch(next);
      response.status(202).json(manager.status());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/harness/local-semantic/import", requireAuth, upload.single("file"), async (request, response, next) => {
    const file = request.file;
    if (!file?.path) {
      response.status(400).json({ error: "A local semantic component archive file is required." });
      return;
    }
    try {
      const pending = manager.importArchive(file.path);
      void pending.catch(next).finally(() => rm(file.path, { force: true }).catch(() => undefined));
      response.status(202).json(manager.status());
    } catch (error) {
      await rm(file.path, { force: true }).catch(() => undefined);
      next(error);
    }
  });

  app.post("/api/harness/local-semantic/cancel", requireAuth, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(manager.cancel());
  });
};
