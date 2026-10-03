import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SemanticCheckpoint } from "./store-contract.js";

const checkpointPath = (spaceDir: string): string => join(spaceDir, "current.json");

export const readSemanticCheckpoint = (spaceDir: string): SemanticCheckpoint | null => {
  try {
    const raw = JSON.parse(readFileSync(checkpointPath(spaceDir), "utf8")) as SemanticCheckpoint;
    if (!raw.generation || !raw.spaceId || !raw.recipeId) return null;
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const writeSemanticCheckpoint = (spaceDir: string, checkpoint: SemanticCheckpoint): void => {
  mkdirSync(spaceDir, { recursive: true });
  const target = checkpointPath(spaceDir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(checkpoint)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
};


