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
const declaration = (method: string, operation: 'read' | 'effect', description: string, inputSchema: JsonObject): VarinExtensionServiceProvision => ({
  id: `varin.computer.${method}`, version: 1,
  tool: { name: `computer_${method}`, description, completion: 'result', operation, inputSchema, outputSchema: { type: 'object' } },
});
/** Product manifest, Host decoder and Tool directory consume this same declaration. */
export const COMPUTER_TOOL_DECLARATIONS = [
  declaration('list', 'read', 'Discover real computers, desktops and reported capabilities. Child executions can discover capabilities, but desktop assignment requests are not connected yet. Desktop discovery may probe the original owner.', schema({})),
  declaration('apps', 'read', 'List applications on an assigned desktop. Root executions can use an enabled desktop; child executions require an assignment, currently unavailable.', schema(desktop)),
  declaration('observe', 'read', 'Observe one app/window through the original desktop owner. Keep observationId for element or screenshot-coordinate actions. Human handback requires a fresh observation. Automatic Agent handback input is not connected.', schema({ ...desktop, app: string, window: { anyOf: [number, string] }, includeScreenshot: { type: 'boolean' }, observationId: string,
    offset: { type: 'integer', minimum: 0 }, textLimit: { anyOf: [{ type: 'integer', minimum: 1 }, { const: 'max' }] },
    maxTreeNodes: { type: 'integer', minimum: 1 }, maxTreeDepth: { type: 'integer', minimum: 1 } }, ['app'])),
  declaration('act', 'effect', 'Perform one action through the assigned physical desktop lane. Dispatch is not proof of application success. Never replay an unknown result. Persistent Computer scripts are not connected.', schema({ ...desktop, action }, ['action'])),
  declaration('cancel', 'effect', 'Cancel the assigned desktop input lane and wait for its original release/drain evidence. Unknown release remains fenced; changing Host or starting a new helper cannot prove cleanup.', schema(desktop)),
  declaration('release', 'effect', 'Release this execution’s actual desktop assignment after original input cleanup. It does not change Computer permissions or the accepted Run source/environment.', schema(desktop)),
] as const;
