/** Namespace metadata owned by one original Documents workspace watcher.
 * The caller supplies the admitted Rust scanner; no content or roots live here. */
export interface CaptureInventoryPosition {
  sourceId: string;
  generation: number;
  complete: boolean;
}

export interface CaptureInventoryOwner extends CaptureInventoryPosition {
  epoch: number;
}

export type CaptureInventoryScan = (scopes?: readonly string[]) => Promise<string[]>;

export interface CaptureInventoryCandidate {
  readonly paths: readonly string[];
}

interface CandidateState {
  owner: CaptureInventoryOwner;
  revision: number;
  sequence: number;
  verified: boolean;
  verifiedComplete: boolean;
}

export class CaptureInventoryChangedError extends Error {
  constructor() {
    super('Directory capture inventory changed during capture');
    this.name = 'CaptureInventoryChangedError';
  }
}

const changed = (): Error => new CaptureInventoryChangedError();
const within = (file: string, scope: string): boolean => file === scope || file.startsWith(`${scope}/`);
const underScope = (file: string, scopes: ReadonlySet<string>): boolean => {
  for (;;) {
    if (scopes.has(file)) return true;
    const separator = file.lastIndexOf('/');
    if (separator < 0) return false;
    file = file.slice(0, separator);
  }
};
const sameOwner = (left: CaptureInventoryOwner, right: CaptureInventoryOwner): boolean => (
  left.epoch === right.epoch && left.sourceId === right.sourceId && left.generation === right.generation
);

const normalize = (file: string): string => {
  const relative = file.replace(/\\/g, '/');
  if (relative.includes('\0') || relative.startsWith('/') || /^[a-z]:/i.test(relative)) {
    throw new Error('Directory capture inventory path is outside its namespace');
  }
  const segments = relative.split('/');
  if (segments.includes('..')) throw new Error('Directory capture inventory path is outside its namespace');
  return segments.filter(segment => segment !== '' && segment !== '.').join('/');
};

// The root Rust inventory excludes these entries at every depth. Explicit
// captureScopes have their own inventory and must not widen this baseline.
const excluded = (file: string): boolean => file.split('/').some(segment => segment === '.git' || segment === '.varin');

const scanPaths = (paths: readonly string[], scopes?: ReadonlySet<string>): string[] => {
  const result = new Set<string>();
  for (const path of paths) {
    const file = normalize(path);
    if (!file || excluded(file)) continue;
    if (scopes && !underScope(file, scopes)) {
      throw new Error('Directory capture inventory scan escaped its requested scopes');
    }
    result.add(file);
  }
  return [...result].sort();
};

export const createCaptureInventory = () => {
  let owner: CaptureInventoryOwner | undefined;
  let baseline: readonly string[] | undefined;
  let revision = 0;
  let sequence = 0;
  let committedSequence = 0;
  const dirty = new Set<string>();
  const candidates = new WeakMap<CaptureInventoryCandidate, CandidateState>();

  const reset = (): void => {
    revision += 1;
    baseline = undefined;
    dirty.clear();
  };

  const observe = (position: CaptureInventoryOwner): void => {
    if (owner && (!sameOwner(owner, position) || (owner.complete && !position.complete))) reset();
    owner = { ...position };
  };

  const assertCurrent = (state: CandidateState): void => {
    if (state.revision !== revision || state.sequence <= committedSequence || !owner || !sameOwner(state.owner, owner)) {
      throw changed();
    }
  };

  const stateFor = (candidate: CaptureInventoryCandidate): CandidateState => {
    const state = candidates.get(candidate);
    if (!state) throw new Error('Directory capture inventory candidate does not belong to this watcher');
    assertCurrent(state);
    return state;
  };

  return {
    /** Call before asynchronous watch metadata work, even for duplicate hints.
     * Missing, root or invalid paths lose coverage rather than inventing a scope. */
    invalidate(path?: string): void {
      let file: string;
      try { file = path === undefined ? '' : normalize(path); }
      catch { reset(); return; }
      if (!file) { reset(); return; }
      if (excluded(file)) return;
      revision += 1;
      // A cold capture already scans the entire namespace. Only a committed
      // baseline needs dirty scopes retained between capture attempts.
      if (!baseline) return;
      if (underScope(file, dirty)) return;
      for (const scope of dirty) if (within(scope, file)) dirty.delete(scope);
      dirty.add(file);
    },

    async prepare(input: CaptureInventoryOwner & { scan: CaptureInventoryScan }): Promise<CaptureInventoryCandidate> {
      const position = { epoch: input.epoch, sourceId: input.sourceId, generation: input.generation, complete: input.complete };
      observe(position);
      const state: CandidateState = { owner: position, revision, sequence: ++sequence, verified: false, verifiedComplete: false };
      let paths: readonly string[];
      if (baseline && input.complete) {
        const scopes = Object.freeze([...dirty].sort());
        if (scopes.length) {
          const previous = baseline;
          const scoped = new Set(scopes);
          const scanned = scanPaths(await input.scan(scopes), scoped);
          paths = [...new Set([...previous.filter(file => !underScope(file, scoped)), ...scanned])].sort();
        } else paths = baseline;
      } else paths = scanPaths(await input.scan());
      assertCurrent(state);
      const candidate: CaptureInventoryCandidate = Object.freeze({ paths: Object.freeze(paths) });
      candidates.set(candidate, state);
      return candidate;
    },

    async verify(candidate: CaptureInventoryCandidate, position: CaptureInventoryPosition, scan: CaptureInventoryScan): Promise<void> {
      const state = stateFor(candidate);
      state.verified = false;
      observe({ epoch: state.owner.epoch, ...position });
      assertCurrent(state);
      const complete = state.owner.complete && position.complete;
      if (!complete) {
        const paths = scanPaths(await scan());
        assertCurrent(state);
        if (paths.length !== candidate.paths.length || paths.some((file, index) => file !== candidate.paths[index])) throw changed();
      }
      state.verified = true;
      state.verifiedComplete = complete;
    },

    /** Publish only after the original Documents completeCapture is stable and
     * the whole capture succeeds. Failed or cancelled work must not call this. */
    commit(candidate: CaptureInventoryCandidate, position: CaptureInventoryOwner): void {
      const state = stateFor(candidate);
      observe(position);
      assertCurrent(state);
      if (!state.verified) throw new Error('Directory capture inventory candidate has not been verified');
      baseline = state.owner.complete && state.verifiedComplete && position.complete ? candidate.paths : undefined;
      dirty.clear();
      committedSequence = state.sequence;
      candidates.delete(candidate);
    },
  };
};
