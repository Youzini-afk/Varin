/** Single untrusted research ingress for both authenticated User requests and selected tools.
* Domain owners retain semantic validation (paths, resources and existing immutable specs). */
import { HarnessServiceError } from '../harness/service-error.js';
export type ResearchMethod = 'submit' | 'list' | 'get' | 'logs' | 'artifact' | 'cancel' | 'collect' | 'wait' | 'resources' | 'sources' | 'register';
const fields: Record<ResearchMethod, readonly string[]> = {
  submit: ['requestId', 'retryOfAttemptId', 'title', 'specId', 'command', 'args', 'cwd', 'env', 'inputs', 'resources', 'outputPaths', 'machineId'],
  list: ['state', 'specId', 'limit'], get: ['attemptId'], logs: ['attemptId', 'stream', 'offset', 'maxBytes'],
  artifact: ['attemptId', 'artifactId', 'offset', 'maxBytes'], cancel: ['attemptId'], collect: ['attemptId'], wait: ['attemptId'],
  resources: [], sources: ['kind'], register: ['kind', 'label', 'uri', 'path', 'objectHash', 'note'],
};
import { ATTEMPT_STATES } from '../harness/experiments.js';
import { SOURCE_KINDS } from '../harness/sources.js';
const fail = (message: string): never => { throw new HarnessServiceError('invalid-params', message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)))
    fail('Invalid research request shape');
}
function string(value: unknown, field: string) { if (typeof value !== 'string' || !value.trim())
  fail(`${field} must be a nonempty string`); }
export function decodeResearchParams(method: ResearchMethod, value: unknown): Record<string, unknown> {
  if (!Object.hasOwn(fields, method))
    fail('Unknown research method');
  shape(value, fields[method]);
  for (const [key, entry] of Object.entries(value)) {
    if (['args', 'outputPaths'].includes(key)) {
      if (!Array.isArray(entry) || !entry.every(v => typeof v === 'string'))
        fail(`${key} must be a string array`);
    }
    else if (key === 'env') {
      if (!object(entry) || !Object.values(entry).every(v => typeof v === 'string'))
        fail('env must be a string map');
    }
    else if (key === 'inputs') {
      if (!Array.isArray(entry))
        fail('inputs must be an array');
      for (const input of entry as unknown[]) {
        shape(input, ['sourceId', 'path', 'objectHash', 'role']);
        for (const [k, v] of Object.entries(input))
          if (typeof v !== 'string')
            fail(`${k} must be a string`);
      }
    }
    else if (key === 'resources') {
      shape(entry, ['cpuCores', 'memoryMb', 'gpuCount', 'gpuMemoryMb', 'longRunning']);
      for (const [k, v] of Object.entries(entry))
        if (k === 'longRunning' ? typeof v !== 'boolean' : typeof v !== 'number' || !Number.isFinite(v) || v < 0)
          fail(`Invalid resource ${k}`);
    }
    else if (['limit', 'offset', 'maxBytes'].includes(key)) {
      if (!Number.isSafeInteger(entry) || Number(entry) < (key === 'maxBytes' ? 1 : 0))
        fail(`${key} must be a valid ${key === 'maxBytes' ? 'positive' : 'nonnegative'} integer`);
    }
    else if (typeof entry !== 'string')
      fail(`${key} must be a string`);
  }
  if (value.state !== undefined && !ATTEMPT_STATES.has(value.state as never))
    fail('Unknown attempt state');
  if (value.kind !== undefined && !SOURCE_KINDS.has(value.kind as string))
    fail('Unknown research source kind');
  if (value.stream !== undefined && !['stdout', 'stderr'].includes(value.stream as string))
    fail('Unknown experiment stream');
  if (['get', 'logs', 'artifact', 'cancel', 'collect', 'wait'].includes(method))
    string(value.attemptId, 'attemptId');
  if (method === 'artifact')
    string(value.artifactId, 'artifactId');
  if (method === 'register')
    string(value.kind, 'kind');
  if (method === 'submit' && !value.specId)
    string(value.command, 'command');
  return structuredClone(value);
}
