import { materialAttachmentRef } from '@varin/protocol';
/** The Host is a typed adapter, not an alias authority. All mappings and accepted
 * targets belong to the same durable Catalog as the original invocation. */
import { isDeepStrictEqual } from 'node:util';
import type { VarinToolReferences, VarinToolReferenceField } from '@varin/extension-contract';
import type { KernelClient } from './kernel-client.js';
import type { HostToolCall, ModelReferenceKind, ModelReferenceRecord, LaunchSource } from './protocol.generated.js';

export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const prefixes: Record<ModelReferenceKind, string> = { message:'msg',item:'item',file:'file',media:'media',read:'read',process:'proc',script:'env',page:'page',observation:'obs',settings:'settings',material:'material',followup:'followup',forward:'forward',job:'job',report:'report' };
export const isModelReference = (value: unknown, kind?: ModelReferenceKind): value is string => typeof value === 'string'
  && (kind ? value.startsWith(`${prefixes[kind]}:`) : Object.values(prefixes).some(prefix => value.startsWith(`${prefix}:`)));
export function createHostModelReferences(kernel: Pick<KernelClient, 'agentRuntimeRequest'>) {
  return {
    async register(kind: ModelReferenceKind, owner: string, target: Record<string, unknown>, holder: string): Promise<string> {
      return (await kernel.agentRuntimeRequest<{ reference: string }, 'runtime.model_reference.register'>('runtime.model_reference.register', {kind,owner,target,holder})).reference;
    },
    resolve(kind: ModelReferenceKind, reference: string, signal?: AbortSignal): Promise<ModelReferenceRecord> {
      return kernel.agentRuntimeRequest('runtime.model_reference.resolve', {kind,reference}, signal);
    },
    async thread(runId:string, identity:string, signal?:AbortSignal):Promise<string> {
      const run=await kernel.agentRuntimeRequest<import('./protocol.generated.js').Run,'runtime.run.inspect'>('runtime.run.inspect',{runId},signal);
      const family=await kernel.agentRuntimeRequest<import('./protocol.generated.js').FamilyList,'runtime.family.list'>('runtime.family.list',{callerThreadId:run.thread_id,includeSelf:true,scope:'all',query:identity},signal);
      const member=family.members.find(member=>member.threadId===identity||member.agentId?.toUpperCase()===identity.toUpperCase());
      if (!member) throw new Error('The selected Agent is outside this task family');
      return member.threadId;
    },
    async source(runId: string, signal?: AbortSignal): Promise<LaunchSource | null> {
      const launch = await kernel.agentRuntimeRequest<import('./protocol.generated.js').LaunchIntent | null, 'runtime.launch.inspect'>('runtime.launch.inspect', {runId}, signal);
      if (!launch) throw new Error('The original invocation source is unavailable');
      return launch.selection.source;
    },
    target(operationId: string, purpose: string, original: unknown, signal?: AbortSignal): Promise<unknown> {
      return kernel.agentRuntimeRequest('runtime.model_reference.target', {operationId,purpose,original}, signal);
    },
    freeze(operationId: string, purpose: string, original: unknown, target: unknown, signal?: AbortSignal): Promise<unknown> {
      return kernel.agentRuntimeRequest('runtime.model_reference.target', {operationId,purpose,original,target}, signal);
    },
  };
}
export type HostModelReferences = ReturnType<typeof createHostModelReferences>;
export type FileReferenceTarget = {kind:'observation';source:LaunchSource;path:string;readVersion:string;format:unknown | null} | {kind:'attachment';reference:string};
export async function resolveFileReference(refs: HostModelReferences, reference: string, signal?: AbortSignal): Promise<FileReferenceTarget> {
  const {target} = await refs.resolve('file', reference, signal);
  if (!object(target)) throw new Error('The original file reference is unavailable');
  if (target.kind === 'attachment' && typeof target.reference === 'string') return target as FileReferenceTarget;
  if (target.kind === 'observation' && object(target.source) && typeof target.path === 'string' && typeof target.readVersion === 'string') return target as FileReferenceTarget;
  throw new Error('This reference is not a file observation or retained attachment');
}
/** Explicit pointer traversal only; * cannot expand arbitrary object properties. */
function positions(root: unknown, path: string): Record<string, unknown>[] {
  let values = [root];
  for (const key of path === '' ? [] : path.slice(1).split('/').map(key => key.replace(/~1/g,'/').replace(/~0/g,'~'))) {
    if (['__proto__','constructor','prototype'].includes(key)) throw new Error('Invalid reference field path');
    values = values.flatMap(value => key === '*' ? Array.isArray(value) ? value : [] : object(value) ? [value[key]] : []);
  }
  return values.filter(object);
}
function put(target: Record<string, unknown>, key: string, value: unknown, replacing?: string) {
  if (target[key] !== undefined && key !== replacing && !isDeepStrictEqual(target[key], value)) throw new Error(`The reference belongs to a different ${key}; use its original target or read again`);
  target[key] = value;
}
async function resolveDeclared(refs: HostModelReferences, args: unknown, declarations: VarinToolReferenceField[], extensionId: string, signal?: AbortSignal) {
  for (const declaration of declarations) for (const position of positions(args, declaration.path)) {
    const reference = position[declaration.reference];
    if (!isModelReference(reference)) continue;
    const selected = await refs.resolve(declaration.kind, reference, signal);
    if (selected.owner !== `extension:${extensionId}:${declaration.owner}` || !object(selected.target)) throw new Error('This reference belongs to a different resource owner');
    for (const key of declaration.fields) if (selected.target[key] !== undefined) put(position,key,selected.target[key],declaration.reference);
    if (!declaration.fields.includes(declaration.reference)) delete position[declaration.reference];
  }
}
async function projectDeclared(refs: HostModelReferences, raw: unknown, output: unknown, declarations: VarinToolReferenceField[], extensionId: string, holder: string) {
  for (const declaration of declarations) {
    const originals = positions(raw,declaration.path), visible = positions(output,declaration.path);
    for (const [index, original] of originals.entries()) {
      const target = Object.fromEntries(declaration.fields.filter(key => original[key] !== undefined).map(key => [key,original[key]]));
      if (!Object.keys(target).length) continue;
      const ref = await refs.register(declaration.kind,`extension:${extensionId}:${declaration.owner}`,target,holder);
      const result = visible[index]!;
      for (const key of declaration.omit ?? declaration.fields) delete result[key];
      result[declaration.reference] = ref;
      if (declaration.kind === 'job' && declaration.path === '') result.operationRef = ref;
    }
  }
}
const owner = {browser:'host.browser',computer:'host.computer',settings:'host.settings',material:'host.material',office:'host.office',forward:'host.forward'};
export interface HostReferenceDeclaration { trustedBuiltin?:boolean; extensionId: string; serviceId: string; references?: VarinToolReferences }
const builtin = (declaration: HostReferenceDeclaration, family: string) => declaration.serviceId.startsWith(`varin.${family}.`) && declaration.trustedBuiltin === true;

export async function resolveHostToolArguments(refs: HostModelReferences, call: HostToolCall, declaration: HostReferenceDeclaration, signal?: AbortSignal): Promise<unknown> {
  const args = structuredClone(call.arguments);
  // Only contracts which own typed positions enter the reference service. Opaque
  // third-party MCP and ordinary extension strings are untouched.
  if (!object(args)) return args;
  const purpose = `host.arguments:${declaration.extensionId}:${declaration.serviceId}`;
  const typedSelections = declaration.trustedBuiltin === true ? [args.ref,args.path,args.id,args.pageId,args.observationId,args.automationEpoch,args.environmentId,args.operationId,args.snapshotId,args.collectionId,args.memberId,object(args.member) ? args.member.snapshotId : undefined,
    ...(Array.isArray(args.files) ? args.files.filter(object).flatMap(item => [item.path,item.snapshotId]):[]),
    ...(Array.isArray(args.items) ? args.items.filter(object).map(item => item.id):[]), object(args.action) ? args.action.observationId : undefined, ...(Array.isArray(args.members) ? args.members.filter(object).map(item => item.snapshotId):[])]:[];
  const computerAction = object(args.action) ? args.action : undefined;
  if (builtin(declaration,'computer')) for (const candidate of [args.target,args.within]) {
    if (object(candidate)) typedSelections.push(candidate.observationId);
  }
  const declaredSelections = (declaration.references?.inputs ?? []).flatMap(position => positions(args,position.path).map(value => value[position.reference]));
  if (![...typedSelections,...declaredSelections].some(value => isModelReference(value))
    && !(builtin(declaration,'web') && call.name === 'materials' && args.action === 'share' && typeof args.targetThreadId === 'string')) return args;
  const frozen = await refs.target(call.operationId,purpose,call.arguments,signal);
  if (frozen !== null) return frozen;
  const resolve = async (kind: ModelReferenceKind, reference: string, expected?: string) => {
    const selected = await refs.resolve(kind,reference,signal);
    if (expected && selected.owner !== expected || !object(selected.target)) throw new Error('The reference belongs to a different resource owner');
    return selected.target as Record<string,unknown>;
  };
  if (isModelReference(args.ref,'read') && declaration.trustedBuiltin === true) {
    const target = await resolve('read',args.ref);
    if (target.tool !== call.name || !object(target.arguments)) throw new Error('This continuation belongs to a different tool');
    if (Object.keys(args).some(key => key !== 'ref')) throw new Error('Use a continuation reference alone, or make a new explicit read');
    return refs.freeze(call.operationId,purpose,call.arguments,target.arguments,signal);
  }
  if (builtin(declaration,'settings') && ['settings_update','settings_read'].includes(call.name)) {
    for (const item of call.name === 'settings_update' && Array.isArray(args.items) ? args.items.filter(object) : [args]) {
      if (!isModelReference(item.id)) continue;
      const target = await resolve('settings',item.id,owner.settings);
      put(item,'id',target.id,'id');
      if (object(target.surface)) {
        const previous = await refs.target(call.operationId,'host.settings.surface',call.arguments,signal);
        if (previous !== null && !isDeepStrictEqual(previous,target.surface)) throw new Error('This settings batch contains observations from different client connections');
        await refs.freeze(call.operationId,'host.settings.surface',call.arguments,target.surface,signal);
      }
      const scope = item.scope ?? target.scope;
      if (target.scope && target.scope !== 'effective' && item.scope !== undefined && item.scope !== target.scope) throw new Error('This settings reference belongs to a different scope');
      if (scope === 'project' && !isDeepStrictEqual(target.source,await refs.source(call.runId,signal))) throw new Error('This settings observation belongs to a different project source');
      if (scope !== undefined && scope !== 'effective') item.scope = scope;
      if (call.name === 'settings_update') {
        const revision = object(target.revisions) ? target.revisions[typeof scope === 'string' && scope !== 'effective' ? scope : 'global'] : target.revision;
        if (revision !== undefined && target.consistency !== 'last-write-wins') put(item,'expectedRevision',revision);
      }
    }
  }
  if (builtin(declaration,'browser')) {
    // A page or observation pins its resource, live instance and original page.
    // Reconnection must not reinterpret a short reference in a new browser.
    for (const field of ['pageId','observationId']) if (isModelReference(args[field])) {
      const kind = isModelReference(args[field],'observation') ? 'observation' : 'page';
      const target = await resolve(kind,args[field] as string,owner.browser);
      for (const key of call.name === 'browser_act' ? ['browserId','instanceId','pageId','observationId'] : ['browserId','instanceId','pageId']) if (target[key] !== undefined) put(args,key,target[key],field);
      if (field === 'observationId' && target.observationId === undefined) throw new Error('Coordinate input requires an observation, not only a page');
    }
  }
  if (builtin(declaration,'computer')) {
    const within = object(args.within) ? args.within : undefined;
    const element = object(args.target) ? args.target : undefined;
    for (const [position,field,nested] of [[args,'observationId',false],[args,'automationEpoch',false],[computerAction,'observationId',false],
      [within,'observationId',true],[element,'observationId',true]] as const) {
      if (!position || !isModelReference(position[field])) continue;
      const target = await resolve('observation',position[field] as string,owner.computer);
      if (target.desktopId !== undefined) put(args,'desktopId',target.desktopId);
      if (field === 'observationId' && typeof target.observationId !== 'string') throw new Error('This reference is not an observation');
      if (field === 'automationEpoch' && typeof target.automationEpoch !== 'string') throw new Error('This reference has no automation epoch');
      if (target.automationEpoch !== undefined && (position === computerAction || field === 'automationEpoch')) {
        put(args,'automationEpoch',target.automationEpoch,field === 'automationEpoch' ? field : undefined);
      }
      if (field === 'observationId') {
        for (const key of nested ? ['observationId'] : ['observationId','app','window']) {
          if (target[key] !== undefined && (key === field || position[key] === undefined)) put(position,key,target[key],field);
        }
      }
    }
  }
  if (builtin(declaration,'script') && isModelReference(args.environmentId)) {
    const target = await resolve('script',args.environmentId);
    args.environmentId = target.operationId;
  }
  if (builtin(declaration,'environment') && call.name.startsWith('environment_forward') && isModelReference(args.operationId)) {
    args.operationId = (await resolve('forward',args.operationId,owner.forward)).operationId;
  }
  const snapshot = async (reference:string) => {
    const target=await resolve('material',reference,owner.material);
    if (typeof target.snapshotId !== 'string') throw new Error('This material reference does not select a snapshot');
    return target.snapshotId;
  };
  if ((builtin(declaration,'web') || builtin(declaration,'office')) && isModelReference(args.snapshotId)) args.snapshotId = await snapshot(args.snapshotId);
  if (builtin(declaration,'web') && call.name==='materials') {
    if (isModelReference(args.collectionId)) {
      const target=await resolve('material',args.collectionId,owner.material);
      if (target.kind!=='collection' || typeof target.collectionId!=='string') throw new Error('This material reference does not select a collection');
      args.collectionId=target.collectionId;
    }
    if (isModelReference(args.memberId)) {
      const target=await resolve('material',args.memberId,owner.material);
      if (target.kind!=='member' || typeof target.memberId!=='string') throw new Error('This material reference does not select a collection member');
      put(args,'collectionId',target.collectionId);args.memberId=target.memberId;
    }
    if (args.action==='share' && typeof args.targetThreadId==='string') args.targetThreadId=await refs.thread(call.runId,args.targetThreadId,signal);
  }
  if (builtin(declaration,'office') && call.name === 'office_write' && isModelReference(args.path,'file')) {
    const target = await resolveFileReference(refs,args.path,signal);
    if (target.kind !== 'observation') throw new Error('An attachment is fixed content; choose an output path to write a copy');
    if (!isDeepStrictEqual(target.source,await refs.source(call.runId,signal))) throw new Error('This file observation belongs to a different source');
    args.path = target.path;
  }
  if (builtin(declaration,'browser') && call.name === 'browser_files' && Array.isArray(args.files)) for (const file of args.files.filter(object)) {
    if (isModelReference(file.snapshotId)) file.snapshotId = await snapshot(file.snapshotId);
    // file observations stay typed until the source owner conditionally captures
    // their original version. Replacing them with a raw path would lose the CAS.
  }
  if (builtin(declaration,'web') && object(args.member) && isModelReference(args.member.snapshotId)) args.member.snapshotId = await snapshot(args.member.snapshotId);
  if (builtin(declaration,'web') && Array.isArray(args.members)) for (const member of args.members.filter(object)) if (isModelReference(member.snapshotId)) member.snapshotId = await snapshot(member.snapshotId);
  await resolveDeclared(refs,args,declaration.references?.inputs ?? [],declaration.extensionId,signal);
  if (isDeepStrictEqual(args,call.arguments)) return args;
  return refs.freeze(call.operationId,purpose,call.arguments,args,signal);
}

export async function projectHostToolData(refs: HostModelReferences, call: HostToolCall, declaration: HostReferenceDeclaration, raw: unknown, source?: LaunchSource | null, resolvedArguments?: unknown): Promise<unknown> {
  const output = structuredClone(raw);
  if (!object(output) || !object(raw)) {
    await projectDeclared(refs,raw,output,declaration.references?.outputs ?? [],declaration.extensionId,call.operationId);
    return output;
  }
  const register = (kind: ModelReferenceKind, resourceOwner: string, target: Record<string,unknown>) => refs.register(kind,resourceOwner,target,call.operationId);
  if (builtin(declaration,'settings') && call.name === 'settings_read' && object(raw.entry) && typeof raw.entry.id === 'string') {
    const args = object(resolvedArguments) ? resolvedArguments : object(call.arguments) ? call.arguments : {};
    const scope = args.scope ?? raw.entry.scope;
    output.ref = await register('settings',owner.settings,{id:raw.entry.id,...(scope !== undefined ? {scope}:{}),...(object(raw.referenceTarget) ? {surface:raw.referenceTarget}:{}),
      ...(raw.revision !== undefined ? {revision:raw.revision}:{}),...(raw.revisions !== undefined ? {revisions:raw.revisions}:{}),...(raw.consistency !== undefined ? {consistency:raw.consistency}:{}),source:source ?? null});
    delete output.revision; delete output.revisions; delete output.referenceTarget;
  }
  if (builtin(declaration,'browser')) {
    const binding = object(raw.binding) ? raw.binding : {};
    const identity = typeof binding.browserId === 'string' && typeof binding.instanceId === 'string'
      ? { browserId: binding.browserId, instanceId: binding.instanceId } : {};
    const pageRefs = new Map<string, string>();
    const pageReference = async (pageId: string) => {
      let reference = pageRefs.get(pageId);
      if (!reference) { reference = await register('page',owner.browser,{...identity,pageId}); pageRefs.set(pageId,reference); }
      return reference;
    };
    const pages = Array.isArray(raw.pages) ? raw.pages.filter(object) : object(raw.page) ? [raw.page] : [];
    const visible = Array.isArray(output.pages) ? output.pages.filter(object) : object(output.page) ? [output.page] : [];
    for (const [index,page] of pages.entries()) if (typeof page.pageId === 'string') {
      visible[index]!.pageId = await pageReference(page.pageId);
      delete visible[index]!.browserId; delete visible[index]!.instanceId;
    }
    if (typeof raw.observationId === 'string' && object(raw.page) && typeof raw.page.pageId === 'string') {
      output.observationId = await register('observation',owner.browser,{...identity,pageId:raw.page.pageId,observationId:raw.observationId});
    }
    if (typeof raw.pageId === 'string') output.pageId = await pageReference(raw.pageId);
    if (Array.isArray(output.downloads)) for (const download of output.downloads.filter(object)) {
      if (typeof download.pageId === 'string') download.pageId = await pageReference(download.pageId);
    }
    delete output.browserId; delete output.instanceId; delete output.binding;
  }
  if (builtin(declaration,'computer')) {
    // Register the original observation in Catalog; only compact, human-scale
    // facts go to the model. The stored result remains untouched for the UI.
    const originals = [raw,raw.result,raw.last].filter(object);
    const projected = [output,output.result,output.last].filter(object);
    const refsByObservation = new Map<string,string>();
    for (const [i, original] of originals.entries()) {
      const observation = original.observation;
      const target = projected[i];
      if (!target || !object(observation) || typeof observation.id !== 'string' || typeof observation.desktopId !== 'string') continue;
      const app = object(observation.app) ? observation.app : {};
      let id = refsByObservation.get(observation.id);
      if (!id) {
        try {
          id = await register('observation',owner.computer,{observationId:observation.id,desktopId:observation.desktopId,
            ...(app.pid !== undefined ? {app:String(app.pid)} : typeof app.name === 'string' ? {app:app.name}:{}),
            ...(observation.windowHandle !== undefined ? {window:observation.windowHandle}:{}),
            ...(typeof observation.automationEpoch === 'string' ? {automationEpoch:observation.automationEpoch}:{})});
          refsByObservation.set(observation.id,id);
        } catch {
          // Preserve the read facts and settled action receipt, not the raw
          // native identifiers, when Catalog cannot publish a short reference.
        }
      }
      const pick = (value: Record<string,unknown>, fields: readonly string[]) =>
        Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key,value[key]]));
      const elements = Array.isArray(observation.elements) ? observation.elements.filter(object) : [];
      const windowFields = ['windowTitle','view','complete','truncatedReason','treePage','focusedSummary','selectedText','screenshot','windowCount'];
      target.observation = { ...(id ? { id } : { referenceUnavailable: true }), app: app.name, ...pick(observation,windowFields),
        ...(Array.isArray(observation.windows) ? { windows: observation.windows.filter(object).map(window => pick(window,['handle','title','visible','minimized','main'])) } : {}),
        ...(elements.length ? { elements: elements.map(element => ({
          ...pick(element,['index','parentIndex','depth','name','value','enabled','selected','checked','expanded','actions','hasMoreChildren','ancestorNames']),
          role: element.role ?? element.controlType ?? element.localizedControlType,
          ...(element.platformRole !== undefined ? { platformRole: element.platformRole } : {}),
          ...(observation.screenshot && element.frame ? { frame: element.frame } : {}),
        })) } : Array.isArray(observation.treeLines) && observation.treeLines.length ? { treeLines: observation.treeLines } : {}),
      };
    }
    if (object(raw.control) && object(output.control) && typeof raw.control.automationEpoch === 'string') {
      const desktopId = raw.control.desktopId ?? (object(raw.assignment) ? raw.assignment.desktopId : undefined);
      output.control.automationEpoch = await register('observation',owner.computer,{automationEpoch:raw.control.automationEpoch,...(desktopId !== undefined ? {desktopId}:{})});
    }
  }
  if (builtin(declaration,'script') && typeof raw.environmentId === 'string') {
    output.environmentId = await register('script',source ? JSON.stringify(source.resource_owner) : 'managed_process',{operationId:raw.environmentId});
    if (call.name === 'script_open') output.operationRef = output.environmentId;
    delete output.cellId;
  }
  if (builtin(declaration,'environment') && call.name.startsWith('environment_forward')) {
    const originals = Array.isArray(raw.jobs) ? raw.jobs.filter(object) : [raw];
    const visible = Array.isArray(output.jobs) ? output.jobs.filter(object) : [output];
    for (const [index,item] of originals.entries()) if (typeof item.operationId === 'string') {
      visible[index]!.operationId = await register('forward',owner.forward,{operationId:item.operationId});
      if (!Array.isArray(raw.jobs)) output.operationRef = visible[index]!.operationId;
      delete visible[index]!.originalAcceptance;
      // Listener identity is hidden, human-meaningful endpoint/address stays.
      if (object(visible[index]!.owner)) { const selected = visible[index]!.owner as Record<string,unknown>; delete selected.hostEpoch; }
    }
  }
  if (builtin(declaration,'web') && call.name==='materials') {
    const args=object(resolvedArguments)?resolvedArguments:object(call.arguments)?call.arguments:{};
    const collectionId=object(raw.collection)&&typeof raw.collection.collectionId==='string'?raw.collection.collectionId:args.collectionId;
    for (const path of ['/collection','/collections/*']) {
      const originals=positions(raw,path),visible=positions(output,path);
      for (const [index,item] of originals.entries()) if (typeof item.collectionId==='string') visible[index]!.collectionId=await register('material',owner.material,{kind:'collection',collectionId:item.collectionId});
    }
    if (object(raw.grant) && object(output.grant)) {
      delete output.grant.grantId;delete output.grant.fromThreadId;delete output.grant.toThreadId;
      if (object(call.arguments) && typeof call.arguments.targetThreadId==='string') output.grant.target=call.arguments.targetThreadId;
      if (Array.isArray(raw.grant.snapshotIds)) output.grant.snapshotIds=await Promise.all(raw.grant.snapshotIds.filter((id):id is string=>typeof id==='string').map(snapshotId=>register('material',owner.material,{snapshotId})));
      if (Array.isArray(raw.grant.collectionIds)) output.grant.collectionIds=await Promise.all(raw.grant.collectionIds.filter((id):id is string=>typeof id==='string').map(collectionId=>register('material',owner.material,{kind:'collection',collectionId})));
    }
    if (typeof collectionId==='string') for (const path of ['/collection/members/*','/member','/hits/*']) {
      const originals=positions(raw,path),visible=positions(output,path);
      for (const [index,item] of originals.entries()) if (typeof item.memberId==='string') visible[index]!.memberId=await register('material',owner.material,{kind:'member',collectionId,memberId:item.memberId});
    }
  }
  if (builtin(declaration,'office') && call.name === 'office_read' && typeof raw.snapshotId === 'string') {
    output.ref = object(raw.sourceObservation) && typeof raw.sourceObservation.path === 'string' && typeof raw.sourceObservation.readVersion === 'string' && source
      ? await register('file',JSON.stringify(source.resource_owner),{kind:'observation',source,path:raw.sourceObservation.path,readVersion:raw.sourceObservation.readVersion,format:null})
      : await register('file','attachment',{kind:'attachment',reference:materialAttachmentRef(raw.snapshotId)});
    delete output.sourceObservation;
    if (object(raw.sourceObservation)) delete output.revision;
  }
  if ((builtin(declaration,'web') || builtin(declaration,'office') || builtin(declaration,'browser')) && typeof raw.snapshotId === 'string') {
    output.snapshotId = await register('material',owner.material,{snapshotId:raw.snapshotId});
    delete output.contentHash;
  }
  if (builtin(declaration,'web') || builtin(declaration,'office') || builtin(declaration,'browser')) {
    // These are domain-declared result positions, not arbitrary third-party JSON.
    for (const path of ['/snapshot','/sourceSnapshot','/items/*/fetch/snapshot','/items/*/results/*/source/snapshot','/members/*/snapshot','/items/*/snapshot','/collection/members/*','/member','/hits/*']) {
      const originals = positions(raw,path), visible = positions(output,path);
      for (const [index,item] of originals.entries()) if (typeof item.snapshotId === 'string') {
        visible[index]!.snapshotId = await register('material',owner.material,{snapshotId:item.snapshotId});
        delete visible[index]!.contentHash;
        if (object(item.document) && object(visible[index]!.document)) {
          const document = visible[index]!.document as Record<string,unknown>;
          if (typeof item.document.sourceSnapshotId === 'string') document.sourceSnapshotId = await register('material',owner.material,{snapshotId:item.document.sourceSnapshotId});
          if (object(document.source)) delete document.source.contentHash;
        }
      }
    }
    for (const path of ['/items/*/fetch','/items/*/results/*']) {
      const originals=positions(raw,path), visible=positions(output,path);
      for (const [index,item] of originals.entries()) if (object(item.nextRead)) {
        const tool='webfetch';
        visible[index]!.nextRead={tool,arguments:{ref:await register('read',owner.material,{tool,source:null,arguments:item.nextRead})}};
      }
    }
    for (const path of ['/document','/pageImage','/pageImages/*']) {
      const originals=positions(raw,path),visible=positions(output,path);
      for (const [index,item] of originals.entries()) {
        delete visible[index]!.sourceHash;
        if (typeof item.sourceSnapshotId === 'string') visible[index]!.sourceSnapshotId=await register('material',owner.material,{snapshotId:item.sourceSnapshotId});
      }
    }
    if (object(raw.nextRead)) {
      const tool = call.name === 'office_render' || call.name === 'browser_files' ? 'document_read' : call.name;
      output.nextRead = {tool,arguments:{ref:await register('read',owner.material,{tool,source:null,arguments:raw.nextRead})}};
    }
  }
  await projectDeclared(refs,raw,output,declaration.references?.outputs ?? [],declaration.extensionId,call.operationId);
  return output;
}
