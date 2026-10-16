import { THINKING_LEVELS } from '@varin/protocol';
import { create } from 'zustand';
import { getRuntimeEndpointGeneration, ThreadRequestError, type ThreadIdentity, type ThreadPreparedSource, type ThreadPrepareSource, type ThreadSubmit, type ThreadsAPI, type ThreadUpdate } from '@varin/application-client';
import type { ImageAttachment, InputSubmitReceipt } from '@varin/protocol';
import type { CreateMultiRunParams, CreateMultiRunResult, MultiRunFileAttachment, MultiRunModelSelection } from '@/types/multirun';
import { getWorktreeSetupWaitEnabled, type VarinProjectRef } from '@/lib/project-config';
import { checkVarinGitRepository, createVarinWorktree, resolveVarinRootTrackingRemote } from '@/lib/varinWorktrees';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { getMultiRunSessionTitle } from '@/lib/multirun/title';
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';
import { threadHostKey, useThreadStore } from './useThreadStore';
const toGitSafeSlug = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '-')
  .replace(/^-+|-+$/g, '');

const stableFallbackSlug = (value: string): string => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `group-${(hash >>> 0).toString(36)}`;
};

const toModelSlug = (providerID: string, modelID: string): string => {
  const provider = toGitSafeSlug(providerID) || 'provider';
  const model = toGitSafeSlug(modelID) || 'model';
  return `${provider}-${model}`;
};

const generateWorktreeNameSeed = (groupSlug: string, modelSlug: string): string => (
  `${groupSlug}/${modelSlug}`
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const dataUrlParts = (url: string): { base64: boolean; data: string; mime: string } | null => {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(url);
  if (!match) return null;
  return {
    base64: match[2] !== undefined,
    data: match[3] ?? '',
    mime: match[1] || 'application/octet-stream',
  };
};

const decodeBase64Text = (value: string): string => {
  const decoded = atob(value);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const isTextAttachment = (mime: string): boolean => (
  mime.startsWith('text/')
  || /\/(?:json|jsonc|javascript|typescript|xml|yaml|x-yaml|toml)(?:$|;)/i.test(mime)
);

const escapeAttribute = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const prepareAttachments = (
  files: MultiRunFileAttachment[] | undefined,
): { images: ImageAttachment[]; instructions?: string } => {
  const images: ImageAttachment[] = [];
  const blocks: string[] = [];
  for (const file of files ?? []) {
    const parsed = dataUrlParts(file.url);
    const mime = file.mime || parsed?.mime || 'application/octet-stream';
    if (mime.startsWith('image/') && parsed?.base64) {
      images.push({ data: parsed.data, mimeType: mime });
      continue;
    }
    let body = file.url;
    let encoding = 'data-url';
    if (parsed && isTextAttachment(mime)) {
      try {
        body = parsed.base64 ? decodeBase64Text(parsed.data) : decodeURIComponent(parsed.data);
        encoding = 'text';
      } catch {
        body = file.url;
      }
    }
    blocks.push(
      `<attachment name="${escapeAttribute(file.filename)}" mime="${escapeAttribute(mime)}" encoding="${encoding}">\n${body}\n</attachment>`,
    );
  }
  return {
    images,
    ...(blocks.length === 0
      ? {}
      : { instructions: `The user attached the following files to this run:\n${blocks.join('\n')}` }),
  };
};


export interface MultiRunAttempt {
  id: string;
  model: MultiRunModelSelection;
  prompt: string;
  title: string;
  preferredName: string;
  createKey: string;
  sourceKey: string;
  worktreePath?: string;
  worktreeUnknown?: boolean;
  worktreeReady?: boolean;
  identity?: ThreadIdentity;
  titleCommand?: ThreadUpdate;
  titled?: boolean;
  sourceInput?: ThreadPrepareSource;
  prepared?: ThreadPreparedSource;
  input?: ThreadSubmit;
  receipt?: InputSubmitReceipt;
  status: 'pending' | 'preparing' | 'ready' | 'accepted' | 'unknown' | 'error' | 'stopped';
  error?: string;
}
interface Batch {
  fingerprint: string;
  generation: number;
  hostKey: string;
  groupSlug: string;
  params: CreateMultiRunParams;
  project: VarinProjectRef;
  api: ThreadsAPI;
  isolated?: boolean;
  trackingRemote?: string | null;
  waitForSetup?: boolean;
  attempts: MultiRunAttempt[];
  stopped: boolean;
}
interface MultiRunStore {
  ownerHostKey: string | null;
  error: string | null;
  isLoading: boolean;
  attempts: MultiRunAttempt[];
  clearError(): void;
  stopLaunching(): void;
  keepResultsAndReset(): void;
  createMultiRun(params: CreateMultiRunParams): Promise<CreateMultiRunResult | null>;
}
let batch: Batch | undefined;
let pending: Promise<CreateMultiRunResult | null> | undefined;
const sameSelection = (left: ThreadIdentity | null, right: ThreadIdentity | null) => left?.threadId === right?.threadId && left?.branchId === right?.branchId;
class BatchRetired extends Error {}
const assertOwner = (owner: Batch) => {
  if (owner.generation !== getRuntimeEndpointGeneration() || owner.hostKey !== threadHostKey()) throw new BatchRetired('Application Host changed. Existing work and uncertain outcomes remain with their original Host.');
  if (owner.stopped) throw new BatchRetired('Launching stopped. Existing conversations and worktrees were retained.');
};
function createBatch(params: CreateMultiRunParams): Batch {
  if (!params.name.trim() || !params.groups.length || params.groups.some(group => !group.prompt.trim() || !group.models.length)) throw new Error('Choose a name, prompt and model for every run group.');
  const state = useProjectsStore.getState(); const project = state.projects.find(value => value.id === state.activeProjectId);
  const path = project?.path ?? useDirectoryStore.getState().currentDirectory;
  if (!path) throw new Error('Select a project on this Host.');
  const api = getRegisteredRuntimeAPIs()?.threads; if (!api) throw new Error('Native thread execution is unavailable.');
  const groupSlug = toGitSafeSlug(params.name.trim()) || stableFallbackSlug(params.name.trim());
  const attachments = prepareAttachments(params.files);
  const attempts = params.groups.flatMap((group, groupIndex) => group.models.map((model, modelIndex) => {
    const runGroup = params.groups.length > 1 ? `g${groupIndex + 1}` : undefined;
    const index = group.models.filter(value => value.providerID === model.providerID && value.modelID === model.modelID).length > 1
      ? group.models.slice(0, modelIndex + 1).filter(value => value.providerID === model.providerID && value.modelID === model.modelID).length : undefined;
    if (model.variant !== undefined && !(THINKING_LEVELS as readonly string[]).includes(model.variant)) throw new Error('Unsupported thinking level.');
    return { id: crypto.randomUUID(), model: { ...model }, prompt: [group.prompt, attachments.instructions].filter(Boolean).join('\n\n'),
      title: getMultiRunSessionTitle({ groupSlug, runGroup, providerID: model.providerID, modelID: model.modelID, index }),
      preferredName: [runGroup, generateWorktreeNameSeed(groupSlug, toModelSlug(model.providerID, model.modelID)), index].filter(value => value !== undefined).join('/'),
      createKey: crypto.randomUUID(), sourceKey: crypto.randomUUID(), status: 'pending' as const };
  }));
  return { fingerprint: JSON.stringify(params), generation: getRuntimeEndpointGeneration(), hostKey: threadHostKey(), groupSlug,
    params: structuredClone(params), project: { id: project?.id ?? `path:${path}`, path }, api, attempts, stopped: false };
}

/** Presentation/retry state only. Catalog, Git and source owners retain all accepted resources. */
export const useMultiRunStore = create<MultiRunStore>((set) => {
  const publish = (owner: Batch) => { if (batch === owner) set({ ownerHostKey: owner.hostKey, attempts: owner.attempts.map(attempt => ({ ...attempt })) }); };
  const prepare = async (owner: Batch, attempt: MultiRunAttempt) => {
    if (attempt.receipt) return;
    assertOwner(owner); attempt.status = 'preparing'; attempt.error = undefined; publish(owner);
    if (attempt.worktreeUnknown) throw new Error(`Worktree creation for ${attempt.preferredName} is unconfirmed. Inspect Git on the original Host; this action will not be replayed.`);
    if (!attempt.worktreePath) {
      if (owner.isolated) {
        // Git creation has no idempotent command key. An uncertain result must never be replayed or cleaned up blindly.
        attempt.worktreeUnknown = true; publish(owner); assertOwner(owner);
        const worktree = await createVarinWorktree(owner.project, { branchName: attempt.preferredName, preferredName: attempt.preferredName,
          worktreeName: attempt.preferredName, mode: 'new', resolvedRootTrackingRemote: owner.trackingRemote,
          returnAfterDirectoryCreated: true, setupCommands: owner.params.setupCommands ?? [], startRef: owner.params.worktreeBaseBranch || 'HEAD' });
        attempt.worktreePath = worktree.path; attempt.worktreeUnknown = false; publish(owner); assertOwner(owner);
      } else attempt.worktreePath = owner.project.path;
    }
    if (!attempt.worktreeReady) {
      if (owner.isolated && owner.waitForSetup) { assertOwner(owner); await waitForWorktreeBootstrap(attempt.worktreePath); assertOwner(owner); }
      attempt.worktreeReady = true;
    }
    if (!attempt.identity) {
      assertOwner(owner); attempt.identity = await owner.api.create(attempt.createKey); publish(owner); assertOwner(owner);
    }
    if (!attempt.titled) {
      if (!attempt.titleCommand) {
        assertOwner(owner); const snapshot = await owner.api.snapshot(attempt.identity); assertOwner(owner);
        attempt.titleCommand = { runtime: 'agent', threadId: attempt.identity.threadId, key: crypto.randomUUID(), expectedRevision: snapshot.thread.revision, title: attempt.title };
      }
      assertOwner(owner); await owner.api.update(attempt.titleCommand); attempt.titled = true; assertOwner(owner);
    }
    if (!attempt.sourceInput) {
      assertOwner(owner);
      const workspace = await owner.api.sources.resolve(attempt.identity, { resourceOwner: { kind: 'local' }, path: attempt.worktreePath });
      assertOwner(owner); attempt.sourceInput = { ...attempt.identity, key: attempt.sourceKey, resourceOwner: workspace.resourceOwner,
        workspaceId: workspace.workspaceId, mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [] };
    }
    if (!attempt.prepared) {
      assertOwner(owner); attempt.prepared = await owner.api.prepareSource(attempt.sourceInput); publish(owner); assertOwner(owner);
    }
    if (!attempt.input) {
      const images = prepareAttachments(owner.params.files).images;
      attempt.input = { ...attempt.identity, key: crypto.randomUUID(), expectedHead: null, text: attempt.prompt,
        model: { providerId: attempt.model.providerID, modelId: attempt.model.modelID, ...(attempt.model.variant ? { thinkingLevel: attempt.model.variant } : {}) },
        source: attempt.prepared.source, ...(images.length ? { images } : {}) };
    }
    attempt.status = 'ready'; publish(owner);
  };
  return {
    ownerHostKey: null, error: null, isLoading: false, attempts: [],
    clearError: () => set({ error: null }),
    keepResultsAndReset: () => { if (!pending) { batch = undefined; set({ error: null }); } },
    stopLaunching: () => { if (batch) { batch.stopped = true; set({ error: 'Launching stopped. Accepted work continues in its original conversations.' }); } },
    createMultiRun(params) {
      if (pending) return pending;
      const work = (async () => {
        let owner: Batch;
        try {
          if (batch && batch.attempts.some(attempt => !attempt.receipt)) {
            if (batch.fingerprint !== JSON.stringify(params)) throw new Error('This batch has unfinished or unconfirmed work. Retry its unchanged selections to reconcile the original commands.');
            owner = batch; assertOwner(owner);
          } else { owner = createBatch(params); batch = owner; }
          set({ isLoading: true, error: null }); publish(owner);
          const initialSelection = useThreadStore.getState().selectedIdentity;
          if (owner.isolated === undefined) {
            assertOwner(owner); const git = await checkVarinGitRepository(owner.project.path); assertOwner(owner);
            owner.isolated = git && owner.params.isolateRuns !== false;
            if (owner.isolated) {
              owner.trackingRemote = await resolveVarinRootTrackingRemote(owner.project.path); assertOwner(owner);
              owner.waitForSetup = await getWorktreeSetupWaitEnabled(owner.project); assertOwner(owner);
            }
          }
          const failures: CreateMultiRunResult['failures'] = [];
          for (const attempt of owner.attempts) {
            try { await prepare(owner, attempt); }
            catch (error) { attempt.status = error instanceof BatchRetired ? 'stopped' : error instanceof ThreadRequestError && error.admission === 'not_started' ? 'error' : 'unknown'; attempt.error = errorMessage(error); publish(owner);
              failures.push({ message: attempt.error, providerID: attempt.model.providerID, modelID: attempt.model.modelID, stage: 'create' }); }
            if (owner.generation !== getRuntimeEndpointGeneration() || owner.stopped) break;
          }
          await Promise.all(owner.attempts.filter(attempt => attempt.status === 'ready' && !attempt.receipt).map(async attempt => {
            try {
              assertOwner(owner); attempt.receipt = await owner.api.submit(attempt.input!); attempt.status = 'accepted'; attempt.error = undefined;
            } catch (error) {
              attempt.status = error instanceof BatchRetired ? 'stopped' : error instanceof ThreadRequestError && error.admission === 'not_started' ? 'error' : 'unknown'; attempt.error = errorMessage(error);
              failures.push({ message: attempt.error, providerID: attempt.model.providerID, modelID: attempt.model.modelID, stage: 'start' });
            } finally { publish(owner); }
          }));
          assertOwner(owner);
          await useThreadStore.getState().loadCatalog().catch(() => {}); assertOwner(owner);
          const identities = owner.attempts.flatMap(attempt => attempt.identity ? [attempt.identity] : []);
          const firstIdentity = identities[0] ?? null;
          if (firstIdentity && !failures.length && sameSelection(initialSelection, useThreadStore.getState().selectedIdentity)) await useThreadStore.getState().selectThread(firstIdentity).catch(() => {});
          set({ error: failures.length ? `${failures.length} run(s) need attention. Existing threads and worktrees were retained; retry keeps the original command keys.` : null });
          return { failures, firstIdentity, identities, groupSlug: owner.groupSlug };
        } catch (error) { set({ error: errorMessage(error) }); return null; }
        finally { set({ isLoading: false }); }
      })(); pending = work;
      void work.finally(() => { if (pending === work) pending = undefined; }); return work;
    },
  };
});
