import { COMPUTER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { compileToolJsonSchema, describeToolSchemaFailure } from '../models/schema.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { ComputerAwaitParams, ComputerObserveParams, ComputerQueryParams } from '@varin/protocol';

const validators = new Map(COMPUTER_TOOL_DECLARATIONS.filter(declaration => ['varin.computer.query', 'varin.computer.await', 'varin.computer.observe'].includes(declaration.id))
  .map(declaration => [declaration.id.slice('varin.computer.'.length), compileToolJsonSchema(declaration.tool!.inputSchema)]));
type Requests = { query: ComputerQueryParams; await: ComputerAwaitParams; observe: ComputerObserveParams };
/** HTTP is a separate untrusted boundary; consume the same declaration as model tools. */
export function computerReadRequest<K extends keyof Requests>(operation: K, body: unknown): Requests[K] {
  const validate = validators.get(operation)!;
  if (!validate(body)) throw new HarnessServiceError('invalid-params', describeToolSchemaFailure(validate, body));
  return body as Requests[K];
}
