import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  isVarinExtensionId,
  VarinExtensionContractError,
  parseVarinExtensionStorageAddress,
  parseVarinExtensionStorageSnapshot,
  type JsonObject,
  type VarinExtensionDiagnostic,
  type VarinExtensionStorageAddress,
  type VarinExtensionStorageDocument,
  type VarinExtensionStorageSnapshot,
} from "@varin/extension-contract";
import { ExtensionStorageError, ExtensionStorageRevisionConflictError } from "./errors.js";

const LOCK_RETRY_MS = 25;
const transactionState = Symbol("extensionStorageTransactionState");
const transactionSetCommitted = Symbol("extensionStorageTransactionSetCommitted");

interface StoredExtensionDocument extends VarinExtensionStorageDocument {
  address: VarinExtensionStorageAddress;
}

interface LastValidStorage {
  document: VarinExtensionStorageDocument;
  exists: boolean;
  fingerprint: string;
}

interface ExtensionStorageTransactionState {
  address: VarinExtensionStorageAddress;
  committed: VarinExtensionStorageSnapshot | null;
  data: JsonObject;
  previous: VarinExtensionStorageSnapshot;
  schemaVersion: number;
  store: ExtensionStorageStore;
}

const errorCode = (error: unknown): string | undefined => (
  typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined
);

const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === "EPERM"; }
};

const acquireLock = async (path: string): Promise<() => Promise<void>> => {
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(path, "wx", 0o600); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    if (handle) {
      const token = randomUUID();
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
      await handle.sync();
      return async () => {
        await handle.close();
        try {
          const owner = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
          if (owner.token === token) await rm(path, { force: true });
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      };
    }
    let abandoned = false;
    try {
      const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
      abandoned = !processIsAlive(Number(owner.pid));
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      try { abandoned = Date.now() - (await stat(path)).mtimeMs > 2_000; }
      catch (statError) { if (errorCode(statError) === "ENOENT") continue; throw statError; }
    }
    if (abandoned) {
      const moved = `${path}.abandoned.${process.pid}.${randomUUID()}`;
      try { await rename(path, moved); }
      catch (error) { if (errorCode(error) === "ENOENT") continue; throw error; }
      await rm(moved, { force: true });
      continue;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
  }
};

const atomicWrite = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
};

const emptyDocument = (): VarinExtensionStorageDocument => ({
  data: {},
  revision: 0,
  schemaVersion: 0,
  updatedAt: new Date(0).toISOString(),
});

const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (
  typeof item === "object" && item !== null && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item
));
const fingerprint = (document: VarinExtensionStorageDocument): string => (
  createHash("sha256").update(canonicalJson(document)).digest("hex")
);

const diagnostic = (address: VarinExtensionStorageAddress, code: string, message: string): VarinExtensionDiagnostic => ({
  code,
  extensionId: address.extensionId,
  message,
  severity: "error",
  timestamp: new Date().toISOString(),
});

const assertJsonObject = (value: JsonObject): JsonObject => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Varin extension storage data is not JSON-safe");
  return JSON.parse(serialized) as JsonObject;
};

export interface ExtensionStorageMigrationInput {
  data: JsonObject;
  fromSchemaVersion: number;
  toSchemaVersion: number;
}

export type ExtensionStorageMigrator = (input: ExtensionStorageMigrationInput) => JsonObject | Promise<JsonObject>;

export class ExtensionStorageMigrationTransaction {
  readonly address: VarinExtensionStorageAddress;
  readonly previous: VarinExtensionStorageSnapshot;
  readonly targetSchemaVersion: number;
  readonly #store: ExtensionStorageStore;
  #targetData: JsonObject;
  #committed: VarinExtensionStorageSnapshot | null = null;

  constructor(options: {
    address: VarinExtensionStorageAddress;
    previous: VarinExtensionStorageSnapshot;
    store: ExtensionStorageStore;
    targetData: JsonObject;
    targetSchemaVersion: number;
  }) {
    this.address = options.address;
    this.previous = options.previous;
    this.#store = options.store;
    this.#targetData = options.targetData;
    this.targetSchemaVersion = options.targetSchemaVersion;
  }

  get targetData(): JsonObject {
    return structuredClone(this.#targetData);
  }

  stageData(data: JsonObject): void {
    if (this.#committed) throw new Error("Cannot stage extension storage after commit");
    this.#targetData = assertJsonObject(data);
  }

  async commit(): Promise<VarinExtensionStorageSnapshot> {
    this.#committed ??= (await this.#store.commitPrepared([this]))[0] as VarinExtensionStorageSnapshot;
    return this.#committed;
  }

  async rollbackCommitted(): Promise<void> {
    if (!this.#committed) return;
    await this.#store.rollbackPrepared([this]);
  }

  [transactionState](): ExtensionStorageTransactionState {
    return {
      address: this.address,
      committed: this.#committed,
      data: structuredClone(this.#targetData),
      previous: this.previous,
      schemaVersion: this.targetSchemaVersion,
      store: this.#store,
    };
  }

  [transactionSetCommitted](snapshot: VarinExtensionStorageSnapshot | null): void {
    this.#committed = snapshot;
  }
}

/** Catalog-owned publication identity; not an extension-provided transaction. */
export interface ExtensionStoragePublication {
  extensionId: string;
  previousIntegrity?: string;
  candidateIntegrity: string;
}
export type ExtensionStoragePublicationResolver = (
  publication: ExtensionStoragePublication, id: string,
) => Promise<"committed" | "uncommitted">;
interface StoragePublicationJournal {
  version: 1;
  id: string;
  publication: ExtensionStoragePublication;
  phase: "prepared" | "committed";
  documents: Array<{ before: VarinExtensionStorageSnapshot; after: VarinExtensionStorageSnapshot }>;
}
function parseStoragePublicationJournal(value: unknown): StoragePublicationJournal {
  const invalid = () => new ExtensionStorageError("storage_invalid", "Invalid storage publication journal; data and receipt preserved");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.id)
    || (raw.phase !== "prepared" && raw.phase !== "committed") || !Array.isArray(raw.documents)
    || typeof raw.publication !== "object" || raw.publication === null || Array.isArray(raw.publication)) throw invalid();
  const publication = raw.publication as Record<string, unknown>;
  if (typeof publication.extensionId !== "string" || !isVarinExtensionId(publication.extensionId)
    || typeof publication.candidateIntegrity !== "string"
    || (publication.previousIntegrity !== undefined && typeof publication.previousIntegrity !== "string")) throw invalid();
  const seen = new Set<string>();
  const documents = raw.documents.map((value: unknown) => {
    if (typeof value !== "object" || value === null) throw invalid();
    const pair = value as Record<string, unknown>;
    const before = parseVarinExtensionStorageSnapshot(pair.before), after = parseVarinExtensionStorageSnapshot(pair.after);
    const key = JSON.stringify(after.address);
    if (JSON.stringify(before.address) !== key || seen.has(key) || !before.authoritative || !after.authoritative
      || !after.exists || after.document.revision !== before.document.revision + 1) throw invalid();
    seen.add(key);
    return { before, after };
  });
  return { version: 1, id: raw.id, phase: raw.phase, documents, publication: {
    extensionId: publication.extensionId, candidateIntegrity: publication.candidateIntegrity,
    ...(typeof publication.previousIntegrity === "string" ? { previousIntegrity: publication.previousIntegrity } : {}),
  } };
}

export class ExtensionStorageStore {
  readonly dataDir: string;
  readonly directory: string;
  readonly #lastValid = new Map<string, LastValidStorage>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.directory = join(this.dataDir, "extensions", "storage");
  }

  read(addressValue: VarinExtensionStorageAddress | unknown): Promise<VarinExtensionStorageSnapshot> {
    const address = parseVarinExtensionStorageAddress(addressValue);
    const path = this.#path(address);
    return this.#serialize(path, async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const release = await acquireLock(`${path}.lock`);
      try { return await this.#readPreserving(address); }
      finally { await release(); }
    });
  }

  /** Keep a reviewed storage revision fixed while its original owner commits a related Catalog decision.
   * The callback must not activate code or re-enter this address. */
  withRevision<T>(
    addressValue: VarinExtensionStorageAddress | unknown,
    expectedRevision: number,
    operation: (snapshot: VarinExtensionStorageSnapshot) => Promise<T>,
  ): Promise<T> {
    const address = parseVarinExtensionStorageAddress(addressValue), path = this.#path(address);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Extension storage expectedRevision must be non-negative");
    return this.#serialize(path, async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const release = await acquireLock(`${path}.lock`);
      try {
        const current = await this.#readPreserving(address);
        if (!current.authoritative) throw new ExtensionStorageError("storage_read_failed", "Cannot commit a related decision from stale extension storage");
        if (current.document.revision !== expectedRevision) throw new ExtensionStorageRevisionConflictError(expectedRevision, current.document.revision);
        return await operation(current);
      } finally { await release(); }
    });
  }

  update(
    addressValue: VarinExtensionStorageAddress | unknown,
    expectedRevision: number,
    schemaVersion: number,
    dataValue: JsonObject,
    expectedSchemaVersion?: number,
  ): Promise<VarinExtensionStorageSnapshot> {
    const address = parseVarinExtensionStorageAddress(addressValue);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) throw new Error("Extension storage schemaVersion must be non-negative");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Extension storage expectedRevision must be non-negative");
    const data = assertJsonObject(dataValue);
    const path = this.#path(address);
    return this.#serialize(path, async () => {
      await mkdir(dirname(path), { mode: 0o700, recursive: true });
      const release = await acquireLock(`${path}.lock`);
      try {
        const current = await this.#readStrict(address);
        if (current.exists && expectedSchemaVersion !== undefined && current.document.schemaVersion !== expectedSchemaVersion) {
          throw new ExtensionStorageError("storage_schema_changed", `Extension storage schema changed from ${expectedSchemaVersion} to ${current.document.schemaVersion}; this original generation cannot write the new schema`);
        }
        if (current.document.revision !== expectedRevision) {
          throw new ExtensionStorageRevisionConflictError(expectedRevision, current.document.revision);
        }
        const document: VarinExtensionStorageDocument = {
          data,
          revision: current.document.revision + 1,
          schemaVersion,
          updatedAt: new Date().toISOString(),
        };
        await atomicWrite(path, { address, ...document });
        this.#lastValid.set(path, { document: structuredClone(document), exists: true, fingerprint: fingerprint(document) });
        return this.#snapshot(address, document, true, true, "ready", []);
      } finally {
        await release();
      }
    });
  }

  async deleteExtensionData(extensionId: string): Promise<void> {
    if (!isVarinExtensionId(extensionId)) throw new Error(`Invalid Varin extension ID: ${extensionId}`);
    const namespace = join(this.directory, extensionId);
    const namespacePrefix = `${namespace}${sep}`;
    const belongsToNamespace = (path: string): boolean => path === namespace || path.startsWith(namespacePrefix);
    const pending = [...this.#queues]
      .filter(([path]) => belongsToNamespace(path))
      .map(([, operation]) => operation);
    await Promise.all(pending);
    await rm(namespace, { force: true, recursive: true });
    for (const path of [...this.#lastValid.keys()]) {
      if (belongsToNamespace(path)) this.#lastValid.delete(path);
    }
    for (const path of [...this.#queues.keys()]) {
      if (belongsToNamespace(path)) this.#queues.delete(path);
    }
  }

  /**
   * Publish candidate data and the Catalog selection as one recoverable decision.
   * The Catalog receipt is the commit point; no extension callback is replayed.
   * Address locks cover both data replacement and the Catalog write.
   */
  async publishPrepared<T>(
    transactions: readonly ExtensionStorageMigrationTransaction[],
    publication: ExtensionStoragePublication,
    commit: (id: string, snapshots: readonly VarinExtensionStorageSnapshot[]) => Promise<T>,
    resolvePublication: ExtensionStoragePublicationResolver,
  ): Promise<T> {
    const states = transactions.map(transaction => transaction[transactionState]());
    if (states.some(state => state.store !== this || state.committed !== null)) {
      throw new Error("Storage publication requires uncommitted transactions from this store");
    }
    const entries = states.map((state, index) => ({ state, index, path: this.#path(state.address) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (new Set(entries.map(entry => entry.path)).size !== entries.length) {
      throw new Error("Storage publication contains a duplicate address");
    }
    const directory = join(this.dataDir, "extensions", "storage-publications");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const releasePublication = await acquireLock(join(directory, "publication.lock"));
    try {
      await this.#recoverPublications(directory, resolvePublication);
      return await this.#serializeMany(entries.map(entry => entry.path), async () => {
        const releases: Array<() => Promise<void>> = [];
        const id = randomUUID();
        const path = join(directory, `${id}.json`);
        let journal: StoragePublicationJournal | undefined;
        try {
          for (const entry of entries) {
            await mkdir(dirname(entry.path), { recursive: true, mode: 0o700 });
            releases.push(await acquireLock(`${entry.path}.lock`));
          }
          const documents = await Promise.all(entries.map(entry => this.#readStrict(entry.state.address)));
          const snapshots = new Array<VarinExtensionStorageSnapshot>(entries.length);
          journal = { version: 1, id, publication, phase: "prepared", documents: entries.map((entry, index) => {
            const before = documents[index]!;
            if (before.document.revision !== entry.state.previous.document.revision
              || fingerprint(before.document) !== fingerprint(entry.state.previous.document)
              || before.exists !== entry.state.previous.exists) {
              throw new ExtensionStorageRevisionConflictError(entry.state.previous.document.revision, before.document.revision);
            }
            const after = this.#snapshot(entry.state.address, {
              data: structuredClone(entry.state.data), schemaVersion: entry.state.schemaVersion,
              revision: before.document.revision + 1, updatedAt: new Date().toISOString(),
            }, true, true, "ready", []);
            snapshots[entry.index] = after;
            return { before: entry.state.previous, after };
          }) };
          await atomicWrite(path, journal);
          for (const { after } of journal.documents) await atomicWrite(this.#path(after.address), { address: after.address, ...after.document });
          const result = await commit(id, snapshots);
          journal.phase = "committed";
          await atomicWrite(path, journal);
          snapshots.forEach((snapshot, index) => {
            transactions[index]?.[transactionSetCommitted](snapshot);
            this.#remember(snapshot);
          });
          // Keep the small committed receipt until the next publication/startup.
          // Cleanup is not part of the user-visible commit outcome.
          return result;
        } catch (error) {
          // A partial data write has no Catalog receipt yet. Recover under the
          // same address locks; if authority/readback is uncertain leave evidence.
          if (journal && journal.phase === "prepared") {
            const decision = await resolvePublication(publication, id);
            if (decision === "uncommitted") {
              await this.#restorePublication(journal, false);
              await rm(path, { force: true });
            } else {
              // The durable Catalog receipt survived a lost response. Record
              // that decision before a later removal can erase its Catalog row.
              journal.phase = "committed";
              await atomicWrite(path, journal);
            }
          }
          throw error;
        } finally { for (const release of releases.reverse()) await release(); }
      });
    } finally { await releasePublication(); }
  }

  /** Called before builtin reconciliation or any extension code is activated. */
  async recoverPublications(
    resolvePublication: ExtensionStoragePublicationResolver,
    afterRecovery?: () => Promise<void>,
  ): Promise<void> {
    const directory = join(this.dataDir, "extensions", "storage-publications");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await acquireLock(join(directory, "publication.lock"));
    try {
      await this.#recoverPublications(directory, resolvePublication);
      // Removal consumes receipts before deleting Catalog identity or data,
      // under the same publication lock used by candidate publication.
      await afterRecovery?.();
    } finally { await release(); }
  }

  async #recoverPublications(directory: string, resolvePublication: ExtensionStoragePublicationResolver): Promise<void> {
    for (const filename of (await readdir(directory)).filter(name => name.endsWith(".json")).sort()) {
      const path = join(directory, filename);
      const journal = parseStoragePublicationJournal(JSON.parse(await readFile(path, "utf8")));
      if (filename !== `${journal.id}.json`) throw new ExtensionStorageError("storage_invalid", "Storage publication identity does not match its file");
      const paths = journal.documents.map(({ after }) => this.#path(after.address)).sort();
      await this.#serializeMany(paths, async () => {
        const releases: Array<() => Promise<void>> = [];
        try {
          for (const documentPath of paths) {
            await mkdir(dirname(documentPath), { recursive: true, mode: 0o700 });
            releases.push(await acquireLock(`${documentPath}.lock`));
          }
          const committed = journal.phase === "committed" || await resolvePublication(journal.publication, journal.id) === "committed";
          await this.#restorePublication(journal, committed);
          await rm(path, { force: true });
        } finally { for (const release of releases.reverse()) await release(); }
      });
    }
  }

  async #restorePublication(journal: StoragePublicationJournal, committed: boolean): Promise<void> {
    const repairs: VarinExtensionStorageSnapshot[] = [];
    for (const { before, after } of journal.documents) {
      const current = await this.#readStrict(after.address);
      const matches = (snapshot: VarinExtensionStorageSnapshot) => current.exists === snapshot.exists
        && fingerprint(current.document) === fingerprint(snapshot.document);
      if (committed && current.document.revision > after.document.revision) continue;
      if (!matches(before) && !matches(after)) {
        throw new ExtensionStorageError("storage_invalid", `Storage publication ${journal.id} conflicts with later data; preserved for recovery`);
      }
      repairs.push(committed ? after : before);
    }
    // Check the complete group before touching any member.
    for (const snapshot of repairs) {
      const path = this.#path(snapshot.address);
      if (snapshot.exists) await atomicWrite(path, { address: snapshot.address, ...snapshot.document });
      else await rm(path, { force: true });
      this.#remember(snapshot);
    }
  }

  #remember(snapshot: VarinExtensionStorageSnapshot): void {
    this.#lastValid.set(this.#path(snapshot.address), {
      document: structuredClone(snapshot.document), exists: snapshot.exists, fingerprint: fingerprint(snapshot.document),
    });
  }

  commitPrepared(
    transactions: readonly ExtensionStorageMigrationTransaction[],
  ): Promise<VarinExtensionStorageSnapshot[]> {
    if (transactions.length === 0) return Promise.resolve([]);
    const states = transactions.map((transaction) => transaction[transactionState]());
    if (states.some((state) => state.store !== this)) throw new Error("Extension storage transaction belongs to another store");
    if (states.every((state) => state.committed !== null)) {
      return Promise.resolve(states.map((state) => structuredClone(state.committed as VarinExtensionStorageSnapshot)));
    }
    if (states.some((state) => state.committed !== null)) throw new Error("Cannot commit a partially committed storage transaction group");
    const entries = states.map((state, index) => ({ index, path: this.#path(state.address), state }))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
      throw new Error("Extension storage transaction group contains a duplicate address");
    }
    return this.#serializeMany(entries.map((entry) => entry.path), async () => {
      const releases: Array<() => Promise<void>> = [];
      try {
        for (const entry of entries) {
          await mkdir(dirname(entry.path), { mode: 0o700, recursive: true });
          releases.push(await acquireLock(`${entry.path}.lock`));
        }
        const current = await Promise.all(entries.map((entry) => this.#readStrict(entry.state.address)));
        current.forEach((value, index) => {
          const expectedRevision = entries[index]?.state.previous.document.revision ?? -1;
          if (value.document.revision !== expectedRevision) {
            throw new ExtensionStorageRevisionConflictError(expectedRevision, value.document.revision);
          }
        });
        const documents = entries.map((entry, index): VarinExtensionStorageDocument => ({
          data: structuredClone(entry.state.data),
          revision: (current[index]?.document.revision ?? 0) + 1,
          schemaVersion: entry.state.schemaVersion,
          updatedAt: new Date().toISOString(),
        }));
        let written = 0;
        try {
          for (; written < entries.length; written += 1) {
            const entry = entries[written] as typeof entries[number];
            await atomicWrite(entry.path, { address: entry.state.address, ...documents[written] });
          }
        } catch (error) {
          const rollbackErrors: string[] = [];
          for (let index = written - 1; index >= 0; index -= 1) {
            const entry = entries[index] as typeof entries[number];
            try {
              if (entry.state.previous.exists) {
                await atomicWrite(entry.path, { address: entry.state.address, ...entry.state.previous.document });
              } else await rm(entry.path, { force: true });
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
            }
          }
          if (rollbackErrors.length > 0) {
            throw new ExtensionStorageError(
              "storage_write_failed",
              `Failed to commit and fully roll back Varin extension storage: ${rollbackErrors.join("; ")}`,
              { cause: error },
            );
          }
          throw error;
        }
        const snapshots: VarinExtensionStorageSnapshot[] = new Array(entries.length);
        entries.forEach((entry, index) => {
          const document = documents[index] as VarinExtensionStorageDocument;
          const snapshot = this.#snapshot(entry.state.address, document, true, true, "ready", []);
          this.#lastValid.set(entry.path, { document: structuredClone(document), exists: true, fingerprint: fingerprint(document) });
          transactions[entry.index]?.[transactionSetCommitted](snapshot);
          snapshots[entry.index] = snapshot;
        });
        return snapshots;
      } finally {
        for (const release of releases.reverse()) await release();
      }
    });
  }

  rollbackPrepared(transactions: readonly ExtensionStorageMigrationTransaction[]): Promise<void> {
    const states = transactions.map((transaction) => transaction[transactionState]());
    const committed = states.map((state, index) => ({ index, state })).filter((entry) => entry.state.committed !== null);
    if (committed.length === 0) return Promise.resolve();
    if (committed.length !== states.length) throw new Error("Cannot roll back a partially committed storage transaction group");
    if (states.some((state) => state.store !== this)) throw new Error("Extension storage transaction belongs to another store");
    const entries = committed.map((entry) => ({ ...entry, path: this.#path(entry.state.address) }))
      .sort((left, right) => left.path.localeCompare(right.path));
    return this.#serializeMany(entries.map((entry) => entry.path), async () => {
      const releases: Array<() => Promise<void>> = [];
      try {
        for (const entry of entries) releases.push(await acquireLock(`${entry.path}.lock`));
        const current = await Promise.all(entries.map((entry) => this.#readStrict(entry.state.address)));
        current.forEach((value, index) => {
          const expectedRevision = entries[index]?.state.committed?.document.revision ?? -1;
          if (value.document.revision !== expectedRevision) {
            throw new ExtensionStorageRevisionConflictError(expectedRevision, value.document.revision);
          }
        });
        for (const entry of entries) {
          if (entry.state.previous.exists) {
            await atomicWrite(entry.path, { address: entry.state.address, ...entry.state.previous.document });
          } else await rm(entry.path, { force: true });
          const document = structuredClone(entry.state.previous.document);
          this.#lastValid.set(entry.path, {
            document,
            exists: entry.state.previous.exists,
            fingerprint: fingerprint(document),
          });
          transactions[entry.index]?.[transactionSetCommitted](null);
        }
      } finally {
        for (const release of releases.reverse()) await release();
      }
    });
  }

  restore(
    addressValue: VarinExtensionStorageAddress | unknown,
    expectedRevision: number,
    previousValue: VarinExtensionStorageSnapshot | unknown,
  ): Promise<VarinExtensionStorageSnapshot> {
    const address = parseVarinExtensionStorageAddress(addressValue);
    const previous = parseVarinExtensionStorageSnapshot(previousValue);
    if (JSON.stringify(previous.address) !== JSON.stringify(address)) throw new Error("Extension storage rollback address does not match");
    if (!previous.authoritative) throw new ExtensionStorageError("storage_read_failed", "Cannot restore non-authoritative extension storage");
    const path = this.#path(address);
    return this.#serialize(path, async () => {
      await mkdir(dirname(path), { mode: 0o700, recursive: true });
      const release = await acquireLock(`${path}.lock`);
      try {
        const current = await this.#readStrict(address);
        if (current.document.revision !== expectedRevision) {
          throw new ExtensionStorageRevisionConflictError(expectedRevision, current.document.revision);
        }
        if (previous.exists) await atomicWrite(path, { address, ...previous.document });
        else await rm(path, { force: true });
        const restored = structuredClone(previous.document);
        this.#lastValid.set(path, { document: restored, exists: previous.exists, fingerprint: fingerprint(restored) });
        return this.#snapshot(
          address,
          restored,
          previous.exists,
          true,
          previous.exists ? "ready" : "missing",
          [],
        );
      } finally {
        await release();
      }
    });
  }

  async prepareMigration(
    addressValue: VarinExtensionStorageAddress | unknown,
    targetSchemaVersion: number,
    migrate: ExtensionStorageMigrator,
  ): Promise<ExtensionStorageMigrationTransaction | null> {
    const address = parseVarinExtensionStorageAddress(addressValue);
    if (!Number.isSafeInteger(targetSchemaVersion) || targetSchemaVersion < 0) throw new Error("Extension storage schemaVersion must be non-negative");
    const previous = await this.read(address);
    if (!previous.authoritative) throw new ExtensionStorageError("storage_read_failed", "Cannot migrate stale extension storage");
    if (previous.document.schemaVersion === targetSchemaVersion) return null;
    const targetData = assertJsonObject(await migrate({
      data: structuredClone(previous.document.data),
      fromSchemaVersion: previous.document.schemaVersion,
      toSchemaVersion: targetSchemaVersion,
    }));
    return new ExtensionStorageMigrationTransaction({ address, previous, store: this, targetData, targetSchemaVersion });
  }

  async prepareWrite(
    addressValue: VarinExtensionStorageAddress | unknown,
    schemaVersion: number,
    dataValue: JsonObject,
  ): Promise<ExtensionStorageMigrationTransaction> {
    const address = parseVarinExtensionStorageAddress(addressValue);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) throw new Error("Extension storage schemaVersion must be non-negative");
    const previous = await this.read(address);
    if (!previous.authoritative) throw new ExtensionStorageError("storage_read_failed", "Cannot write stale extension storage");
    return new ExtensionStorageMigrationTransaction({
      address,
      previous,
      store: this,
      targetData: assertJsonObject(dataValue),
      targetSchemaVersion: schemaVersion,
    });
  }

  #path(address: VarinExtensionStorageAddress): string {
    const keyHash = createHash("sha256").update(address.key).digest("hex");
    return join(this.directory, address.extensionId, address.scope, `${keyHash}.json`);
  }

  async #readStrict(address: VarinExtensionStorageAddress): Promise<{ document: VarinExtensionStorageDocument; exists: boolean }> {
    const path = this.#path(address);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as StoredExtensionDocument;
      const parsed = parseVarinExtensionStorageSnapshot({
        address: raw.address,
        authoritative: true,
        diagnostics: [],
        document: raw,
        exists: true,
        storageState: "ready",
      });
      if (JSON.stringify(parsed.address) !== JSON.stringify(address)) throw new Error("Extension storage address does not match its namespace");
      return { document: parsed.document, exists: true };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { document: emptyDocument(), exists: false };
      throw new ExtensionStorageError(
        error instanceof SyntaxError || error instanceof VarinExtensionContractError
          || (error instanceof Error && error.message.includes("does not match its namespace"))
          ? "storage_invalid"
          : "storage_read_failed",
        "Failed to read Varin extension storage",
        { cause: error },
      );
    }
  }

  async #readPreserving(address: VarinExtensionStorageAddress): Promise<VarinExtensionStorageSnapshot> {
    const path = this.#path(address);
    try {
      const current = await this.#readStrict(address);
      const currentFingerprint = fingerprint(current.document);
      const previous = this.#lastValid.get(path);
      if (previous && current.document.revision < previous.document.revision) {
        return this.#snapshot(address, previous.document, previous.exists, false, "stale", [
          diagnostic(address, "storage_revision_regressed", "Extension storage revision regressed"),
        ]);
      }
      if (previous && current.document.revision === previous.document.revision && currentFingerprint !== previous.fingerprint) {
        return this.#snapshot(address, previous.document, previous.exists, false, "stale", [
          diagnostic(address, "storage_revision_reused", "Extension storage changed without advancing its revision"),
        ]);
      }
      this.#lastValid.set(path, { document: structuredClone(current.document), exists: current.exists, fingerprint: currentFingerprint });
      return this.#snapshot(address, current.document, current.exists, true, current.exists ? "ready" : "missing", []);
    } catch (error) {
      const previous = this.#lastValid.get(path);
      if (previous) return this.#snapshot(address, previous.document, previous.exists, false, "stale", [
        diagnostic(address, "storage_read_failed", "Current extension storage is unreadable; the last valid state is preserved"),
      ]);
      throw error;
    }
  }

  #snapshot(
    address: VarinExtensionStorageAddress,
    document: VarinExtensionStorageDocument,
    exists: boolean,
    authoritative: boolean,
    storageState: "missing" | "ready" | "stale",
    diagnostics: VarinExtensionDiagnostic[],
  ): VarinExtensionStorageSnapshot {
    return { address: structuredClone(address), authoritative, diagnostics, document: structuredClone(document), exists, storageState };
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tracked = result.then(() => undefined, () => undefined);
    this.#queues.set(key, tracked);
    void tracked.finally(() => { if (this.#queues.get(key) === tracked) this.#queues.delete(key); }).catch(() => undefined);
    return result;
  }

  #serializeMany<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
    const uniqueKeys = [...new Set(keys)].sort();
    const previous = Promise.all(uniqueKeys.map((key) => this.#queues.get(key) ?? Promise.resolve()));
    const result = previous.then(operation, operation);
    const tracked = result.then(() => undefined, () => undefined);
    for (const key of uniqueKeys) this.#queues.set(key, tracked);
    void tracked.finally(() => {
      for (const key of uniqueKeys) if (this.#queues.get(key) === tracked) this.#queues.delete(key);
    }).catch(() => undefined);
    return result;
  }
}
