import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { FileSearchItems } from "../fs/types.js";
import type { WorkspaceContentSearchResult } from "./content.js";
import { registerWorkspaceSearchRoutes } from "./routes.js";

const files = (...relativePaths: string[]): FileSearchItems => relativePaths.map((relativePath) => ({
  name: path.basename(relativePath),
  relativePath,
  path: path.join("/workspace", relativePath),
}));

describe("workspace search routes", () => {
  it("serves file-name search and keeps content failure distinct from empty", async () => {
    const fileSearch = { searchFilesystemFiles: vi.fn(async () => files("alpha.ts")) };
    const contentSearch = {
      searchContent: vi.fn(async (_body, options): Promise<WorkspaceContentSearchResult> => ({
        status: "failure",
        generation: options.generation,
        message: "native search failed",
      })),
    };
    const app = express();
    app.use(express.json());
    registerWorkspaceSearchRoutes(app, {
      contentSearch: contentSearch as never,
      fileSearch: fileSearch as never,
      path,
      os,
      resolveProjectDirectory: async () => ({ resolved: "/workspace" }),
    });

    const found = await request(app)
      .get("/api/find/file")
      .query({ query: "alpha", directory: "/workspace", respectGitignore: "false" })
      .expect(200);
    expect(found.body).toEqual(["alpha.ts"]);
    expect(fileSearch.searchFilesystemFiles).toHaveBeenCalledWith("/workspace", expect.objectContaining({
      query: "alpha",
      respectGitignore: false,
      signal: expect.any(AbortSignal),
    }));

    const failed = await request(app)
      .post("/api/workspace/search/content")
      .set("x-varin-generation", "7")
      .send({ workspaceId: "ws", query: "alpha" })
      .expect(200);
    expect(failed.body).toEqual({ status: "failure", generation: 7, message: "native search failed" });
  });

  it("streams content batches and a terminal result over NDJSON", async () => {
    const contentSearch = {
      async searchContent(_body: unknown, options: {
        generation?: number;
        onBatch?: (hits: unknown[]) => boolean | void;
        onDrain?: () => Promise<void>;
      }): Promise<WorkspaceContentSearchResult> {
        options.onBatch?.([{
          resource: { workspaceId: "ws", resourceId: "alpha.ts" },
          line: 1,
          column: 1,
          preview: "alpha",
          revision: "sha256-alpha",
        }]);
        return { status: "ready", generation: options.generation, hits: [], incomplete: true };
      },
    };
    const app = express();
    app.use(express.json());
    registerWorkspaceSearchRoutes(app, {
      contentSearch: contentSearch as never,
      fileSearch: { searchFilesystemFiles: async () => files() } as never,
      path,
      os,
      resolveProjectDirectory: async () => ({ resolved: "/workspace" }),
    });

    const streamed = await request(app)
      .post("/api/workspace/search/content")
      .set("accept", "application/x-ndjson")
      .set("x-varin-generation", "8")
      .send({ workspaceId: "ws", query: "alpha" })
      .expect(200);
    const frames = streamed.text.trim().split("\n").map((line) => JSON.parse(line));
    expect(frames).toEqual([
      { type: "batch", hits: [expect.objectContaining({ preview: "alpha", revision: "sha256-alpha" })] },
      { type: "result", result: { status: "ready", generation: 8, incomplete: true } },
    ]);
  });

  it("does not silently add a file-name limit when the caller did not request one", async () => {
    const fileSearch = {
      searchFilesystemFiles: vi.fn(async (_root: string, _options: { query: string; limit?: number }) => (
        files(...Array.from({ length: 81 }, (_, index) => `match-${index}.ts`))
      )),
    };
    const app = express();
    app.use(express.json());
    registerWorkspaceSearchRoutes(app, {
      contentSearch: { searchContent: async () => ({ status: "empty", generation: 0 }) } as never,
      fileSearch: fileSearch as never,
      path,
      os,
      resolveProjectDirectory: async () => ({ resolved: "/workspace" }),
    });

    const found = await request(app)
      .get("/api/find/file")
      .query({ query: "match", directory: "/workspace", respectGitignore: "false" })
      .expect(200);
    expect(found.body).toHaveLength(81);
    expect(fileSearch.searchFilesystemFiles.mock.calls[0]?.[1]).not.toHaveProperty("limit");
  });

  it("searches an explicitly selected directory outside the active project", async () => {
    const fileSearch = { searchFilesystemFiles: vi.fn(async () => files("external.ts")) };
    const app = express();
    app.use(express.json());
    registerWorkspaceSearchRoutes(app, {
      contentSearch: { searchContent: async () => ({ status: "empty", generation: 0 }) } as never,
      fileSearch: fileSearch as never,
      path,
      os,
      resolveProjectDirectory: async () => ({ resolved: path.resolve("/workspace") }),
      authorizeSearchDirectory: async () => true,
    });

    const found = await request(app)
      .get("/api/find/file")
      .query({ query: "x", directory: path.resolve("/outside") })
      .expect(200);
    expect(found.body).toEqual(["external.ts"]);
    expect(fileSearch.searchFilesystemFiles).toHaveBeenCalledWith(path.resolve("/outside"), expect.objectContaining({ query: "x" }));
  });

  it("rejects directories outside the configured Host roots", async () => {
    const fileSearch = { searchFilesystemFiles: vi.fn(async () => files("should-not-run.ts")) };
    const app = express();
    app.use(express.json());
    registerWorkspaceSearchRoutes(app, {
      contentSearch: { searchContent: async () => ({ status: "empty", generation: 0 }) } as never,
      fileSearch: fileSearch as never,
      path,
      os,
      resolveProjectDirectory: async () => ({ resolved: path.resolve("/workspace") }),
      authorizeSearchDirectory: async () => false,
    });

    await request(app)
      .get("/api/find/file")
      .query({ query: "x", directory: path.resolve("/outside") })
      .expect(403);
    expect(fileSearch.searchFilesystemFiles).not.toHaveBeenCalled();
  });
});
