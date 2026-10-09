/** Immutable native publications belong to the private semantic storage owner.
 * A writer checkpoint copies a complete manifest-backed artifact once; queries
 * only retain its native handle. Never hardlink files that the writer can edit. */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TriviumDB } from "triviumdb";
import type { SemanticCheckpoint, SemanticPublishedReader, SemanticPublishedReaderStats } from "./store-contract.js";

type Backing = {
  db: TriviumDB;
  directory: string;
  references: number;
  closed: boolean;
  documentBlockIds: Map<string, number[]> | null;
};
type Publication = { id: string; checkpoint: SemanticCheckpoint; backing: Backing };

export function createSemanticPublishedReaders(options: {
  directory: string;
  open(file: string): TriviumDB;
  onCleanupError(error: unknown): void;
}) {
  const epoch = randomUUID();
  const directory = join(options.directory, epoch);
  const backings = new Set<Backing>();
  const readers = new Map<string, Publication>();
  let latest: Publication | null = null;
  let nextPublication = 0;
  let nextReader = 0;
  let closed = false;

  const cleanup = (): void => {
    const errors: unknown[] = [];
    for (const backing of backings) {
      if (backing.references > 0) continue;
      try {
        if (!backing.closed) { backing.db.close(); backing.closed = true; }
        rmSync(backing.directory, { recursive: true, force: true });
        backings.delete(backing);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Semantic publication cleanup failed");
  };
  const cleanupRetired = (): void => {
    try { cleanup(); } catch (error) {
      try { options.onCleanupError(error); } catch { /* observational */ }
    }
  };
  const install = (publication: Publication): void => {
    publication.backing.references += 1;
    if (latest) latest.backing.references -= 1;
    latest = publication;
    cleanupRetired();
  };

  return {
    publish(writer: TriviumDB, file: string, checkpoint: SemanticCheckpoint): void {
      if (closed) throw new Error("Semantic publication owner is closed");
      const id = `${epoch}:${++nextPublication}`;
      // In TriviumDB 0.8.8 this operation performs the full checkpoint itself.
      // Its manifest names the active payload generation and every required
      // native sidecar. WAL and lock files are not immutable artifact members.
      const manifest = writer.publishGenerationManifest(id);
      if (!manifest.complete || !Array.isArray(manifest.files)
        || !manifest.files.some(entry => entry.suffix === "")) {
        throw new Error("Incomplete semantic publication manifest");
      }
      mkdirSync(directory, { recursive: true });
      const candidate = mkdtempSync(join(directory, "publication-"));
      let backing: Backing | null = null;
      try {
        for (const entry of manifest.files) {
          if (typeof entry.suffix !== "string" || /[/\\\0]/.test(entry.suffix)
            || (entry.suffix !== "" && !entry.suffix.startsWith("."))) {
            throw new Error("Invalid semantic publication member");
          }
          copyFileSync(`${file}${entry.suffix}`, join(candidate, `index.tdb${entry.suffix}`));
        }
        copyFileSync(`${file}.manifest.json`, join(candidate, "index.tdb.manifest.json"));
        // Native immutable open validates the manifest, dimensions and CRCs.
        const db = options.open(join(candidate, "index.tdb"));
        backing = { db, directory: candidate, references: 0, closed: false, documentBlockIds: null };
        backings.add(backing);
        install({ id, checkpoint: { ...checkpoint }, backing });
      } catch (error) {
        try {
          if (backing) cleanup();
          else rmSync(candidate, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Semantic publication and cleanup both failed");
        }
        throw error;
      }
    },
    /** A final ready/coverage change can reuse the already flushed artifact.
     * Existing leases retain their original immutable checkpoint metadata. */
    refreshCheckpoint(checkpoint: SemanticCheckpoint): void {
      if (!latest || closed) return;
      const previous = latest.checkpoint;
      if (previous.lifecycle === checkpoint.lifecycle && previous.coverage === checkpoint.coverage
        && previous.publishedDocuments === checkpoint.publishedDocuments) return;
      install({ id: `${epoch}:${++nextPublication}`, checkpoint: { ...checkpoint }, backing: latest.backing });
    },
    retain(): SemanticPublishedReader | null {
      if (closed) throw new Error("Semantic publication owner is closed");
      if (!latest) return null;
      const token = `${latest.id}:${++nextReader}`;
      readers.set(token, latest);
      latest.backing.references += 1;
      return { token, ownerEpoch: epoch, publicationId: latest.id, checkpoint: { ...latest.checkpoint } };
    },
    read<T>(token: string, work: (backing: Backing, checkpoint: SemanticCheckpoint) => T): T {
      const publication = readers.get(token);
      if (closed || !publication) throw new Error("Semantic reader is no longer available");
      return work(publication.backing, publication.checkpoint);
    },
    release(token: string): void {
      const publication = readers.get(token);
      if (publication) {
        readers.delete(token);
        publication.backing.references -= 1;
      }
      cleanup();
    },
    stats(): SemanticPublishedReaderStats {
      return { activeReaders: readers.size, retainedPublications: backings.size };
    },
    close(): void {
      closed = true;
      latest = null;
      readers.clear();
      for (const backing of backings) backing.references = 0;
      cleanup();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
