/** Immutable Catalog ownership edges. Create only after principals.initialize.
 * Missing IDs are never cached: a later successful admission may create them. */
export interface OwnershipSelection {
  threads?: readonly string[];
  runs?: readonly string[];
  operations?: readonly string[];
  inputs?: readonly string[];
}
export interface OwnershipResolution {
  threads: Array<{ id: string; principalId: string | null }>;
  runs: Array<{ id: string; threadId: string }>;
  operations: Array<{ id: string; runId: string }>;
  inputs: Array<{ id: string; threadId: string }>;
}
interface OwnershipRuntime { ownershipResolve(selection: OwnershipSelection): Promise<OwnershipResolution> }
const kinds = ['threads', 'runs', 'operations', 'inputs'] as const;
export class OwnershipResolver {
  private readonly threads = new Map<string, string | null>();
  private readonly runs = new Map<string, string>();
  private readonly operations = new Map<string, string>();
  private readonly inputs = new Map<string, string>();
  private readonly inFlight = { threads: new Map<string, Promise<void>>(), runs: new Map<string, Promise<void>>(), operations: new Map<string, Promise<void>>(), inputs: new Map<string, Promise<void>>() };
  private batch: { selection: Record<typeof kinds[number], Set<string>>; promise: Promise<void> } | undefined;
  constructor(private readonly runtime: OwnershipRuntime) {}
  private load(selection: OwnershipSelection): Promise<void> {
    const dependencies = new Set<Promise<void>>();
    for (const kind of kinds) for (const id of selection[kind] ?? []) {
      if (this[kind].has(id)) continue;
      const pending = this.inFlight[kind].get(id);
      if (pending) { dependencies.add(pending); continue; }
      if (!this.batch) {
        const selected = { threads: new Set<string>(), runs: new Set<string>(), operations: new Set<string>(), inputs: new Set<string>() };
        const promise = Promise.resolve().then(async () => {
          this.batch = undefined;
          try {
            const result = await this.runtime.ownershipResolve(Object.fromEntries(kinds.map(kind => [kind, [...selected[kind]]])));
            for (const entry of result.threads) this.threads.set(entry.id, entry.principalId);
            for (const entry of result.runs) this.runs.set(entry.id, entry.threadId);
            for (const entry of result.operations) this.operations.set(entry.id, entry.runId);
            for (const entry of result.inputs) this.inputs.set(entry.id, entry.threadId);
          } finally {
            for (const kind of kinds) for (const id of selected[kind]) {
              if (this.inFlight[kind].get(id) === promise) this.inFlight[kind].delete(id);
            }
          }
        });
        this.batch = { selection: selected, promise };
      }
      this.batch.selection[kind].add(id);
      this.inFlight[kind].set(id, this.batch.promise);
      dependencies.add(this.batch.promise);
    }
    return Promise.all(dependencies).then(() => undefined);
  }
  async owners(selection: OwnershipSelection): Promise<Array<string | null>> {
    await this.load(selection);
    const owners = new Set<string | null>();
    const threadOwner = (id: string | undefined) => {
      if (id === undefined || !this.threads.has(id)) throw Object.assign(new Error('Conversation access denied'), { code: 'forbidden' });
      owners.add(this.threads.get(id)!);
    };
    for (const id of selection.threads ?? []) threadOwner(id);
    for (const id of selection.runs ?? []) threadOwner(this.runs.get(id));
    for (const id of selection.operations ?? []) { const run = this.operations.get(id); threadOwner(run === undefined ? undefined : this.runs.get(run)); }
    for (const id of selection.inputs ?? []) threadOwner(this.inputs.get(id));
    return [...owners];
  }
}
const resolvers = new WeakMap<OwnershipRuntime, OwnershipResolver>();
export const ownershipResolver = (runtime: OwnershipRuntime): OwnershipResolver => {
  let resolver = resolvers.get(runtime);
  if (!resolver) { resolver = new OwnershipResolver(runtime); resolvers.set(runtime, resolver); }
  return resolver;
};
