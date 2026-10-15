import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { HostError } from "../configuration-errors.js";

export interface RevisionedTextFileSnapshot {
  content: string;
  exists: boolean;
  revision: string;
}

interface RevisionedTextFileEditorOptions {
  conflictCode: string;
  conflictLabel: string;
  defaultContent?: string;
  validate?(content: string): void;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

function revisionFor(content: string, exists: boolean): string {
  return createHash("sha256")
    .update(exists ? "present\0" : "missing\0")
    .update(content)
    .digest("hex");
}

export class RevisionedTextFileEditor {
  readonly #options: RevisionedTextFileEditorOptions;
  readonly #path: string;

  constructor(path: string, options: RevisionedTextFileEditorOptions) {
    this.#options = options;
    this.#path = path;
  }

  async read(): Promise<RevisionedTextFileSnapshot> {
    try {
      const content = await readFile(this.#path, "utf8");
      return { content, exists: true, revision: revisionFor(content, true) };
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const content = this.#options.defaultContent ?? "";
      return { content, exists: false, revision: revisionFor(content, false) };
    }
  }

  async update(content: string, expectedRevision: string): Promise<RevisionedTextFileSnapshot> {
    this.#options.validate?.(content);
    return this.#withParentLock(async (compromised) => {
      const current = await this.read();
      this.#assertRevision(current.revision, expectedRevision);
      const lockError = compromised();
      if (lockError) throw lockError;
      const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, content, "utf8");
        const writeLockError = compromised();
        if (writeLockError) throw writeLockError;
        await rename(temporaryPath, this.#path);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      return { content, exists: true, revision: revisionFor(content, true) };
    });
  }

  async delete(expectedRevision: string): Promise<boolean> {
    return this.#withParentLock(async (compromised) => {
      const current = await this.read();
      this.#assertRevision(current.revision, expectedRevision);
      if (!current.exists) return false;
      const lockError = compromised();
      if (lockError) throw lockError;
      await rm(this.#path);
      return true;
    });
  }

  #assertRevision(currentRevision: string, expectedRevision: string): void {
    if (currentRevision === expectedRevision) return;
    throw new HostError(
      this.#options.conflictCode,
      `${this.#options.conflictLabel} changed since it was opened: ${this.#path}`,
      { details: { currentRevision, expectedRevision } },
    );
  }

  async #withParentLock<T>(
    operation: (compromised: () => Error | undefined) => Promise<T>,
  ): Promise<T> {
    const parent = dirname(this.#path);
    await mkdir(parent, { recursive: true });
    let lockError: Error | undefined;
    const release = await lockfile.lock(parent, {
      onCompromised: (error) => {
        lockError = error;
      },
      realpath: false,
      retries: {
        factor: 1.5,
        forever: true,
        maxTimeout: 1_000,
        minTimeout: 20,
        randomize: true,
      },
    });
    try {
      return await operation(() => lockError);
    } finally {
      await release();
    }
  }
}
