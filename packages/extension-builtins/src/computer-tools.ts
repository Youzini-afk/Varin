import type { JsonObject, VarinExtensionServiceProvision } from '@varin/extension-contract';

export const VARIN_BUILTIN_COMPUTER_EXTENSION_ID = 'varin.builtin.computer';
export const COMPUTER_CAPABILITY = 'computer.use';
const string = { type: 'string', minLength: 1 };
const number = { type: 'number' };
const integer = { type: 'integer' };
const desktop = { desktopId: string };
const schema = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: 'object', additionalProperties: false, properties, required });
const action = schema({ kind: { enum: ['click', 'type', 'key', 'scroll', 'drag', 'set_value', 'secondary'] }, app: string,
  window: { anyOf: [number, string] }, observationId: string, elementIndex: integer, x: number, y: number,
  fromX: number, fromY: number, toX: number, toY: number, clickCount: integer,
  mouseButton: { enum: ['left', 'right', 'middle'] }, clickMethod: { enum: ['auto', 'accessibility', 'app_post', 'global'] },
  direction: { enum: ['up', 'down', 'left', 'right'] }, pages: number, text: { type: 'string' }, key: string,
  value: { type: 'string' }, action: string, returnState: { enum: ['none', 'tree', 'screenshot'] },
}, ['kind', 'app']);
const declaration = (method: string, operation: 'read' | 'effect', description: string, inputSchema: JsonObject, job = false): VarinExtensionServiceProvision => ({
  id: `varin.computer.${method}`, version: 1,
  tool: { name: `computer_${method}`, description, completion: job ? 'job' : 'result', ...(job ? { lifetime: 'thread' as const } : {}), operation, inputSchema, outputSchema: { type: 'object' } },
});
/** Product manifest, Host decoder and Tool directory consume this same declaration. */
export const COMPUTER_TOOL_DECLARATIONS = [
  declaration('request', 'effect', 'Ask the root work for a desktop assignment. Returns an accepted pending request, never a grant. Continue other work or explicitly call computer_wait for its decision.', schema({ ...desktop, access: { enum: ['observe', 'control'] }, reason: string }, ['access', 'reason'])),
  declaration('access', 'read', 'Read the original desktop requests and current assignments for this task family. A past granted request alone does not prove its assignment is still available.', schema({})),
  declaration('grant', 'effect', 'As the root work, grant a pending child desktop request through the original physical owner. Other controllers must release first. This does not bypass the child’s tool permissions.', schema({ requestId: string }, ['requestId'])),
  declaration('deny', 'effect', 'As the root work, deny a pending child desktop request with an optional reason.', schema({ requestId: string, reason: string }, ['requestId'])),
  declaration('wait', 'read', 'Explicitly observe this execution’s original Computer request decision. Returns a JobAccepted receipt, parks on the durable event, and delivers the decision once. Cancelling this observation does not cancel the request or release an assignment.', schema({ requestId: string }, ['requestId']), true),
  declaration('list', 'read', 'Discover real computers, desktops and reported capabilities. Child executions can discover capabilities and request a desktop assignment from their root. Desktop discovery may probe the original owner.', schema({})),
  declaration('apps', 'read', 'List applications on an assigned desktop. Root executions can use an enabled desktop; child executions require their original desktop assignment.', schema(desktop)),
  declaration('observe', 'read', 'Observe one app/window through the original desktop owner. Keep observationId for element or screenshot-coordinate actions. Human handback requires a fresh observation. Automatic Agent handback is delivered through the original Computer event receipt.', schema({ ...desktop, app: string, window: { anyOf: [number, string] }, includeScreenshot: { type: 'boolean' }, observationId: string,
    offset: { type: 'integer', minimum: 0 }, textLimit: { anyOf: [{ type: 'integer', minimum: 1 }, { const: 'max' }] },
    maxTreeNodes: { type: 'integer', minimum: 1 }, maxTreeDepth: { type: 'integer', minimum: 1 } }, ['app'])),
  declaration('act', 'effect', 'Perform one action through the assigned physical desktop lane. Dispatch is not proof of application success. Never replay an unknown result. Persistent Node scripts can invoke this ordinary tool with tools.invoke under their original permission and Computer scopes. Native outputs preserve observation metadata in data and screenshots in typed media parts; scripts must explicitly emitImage a returned image to publish it in their own output.', schema({ ...desktop, action }, ['action'])),
  declaration('cancel', 'effect', 'Cancel the assigned desktop input lane and wait for its original release/drain evidence. Unknown release remains fenced; changing Host or starting a new helper cannot prove cleanup.', schema(desktop)),
  declaration('release', 'effect', 'Release this execution’s actual desktop assignment after original input cleanup. It does not change Computer permissions or the accepted Run source/environment.', schema(desktop)),
] as const;
