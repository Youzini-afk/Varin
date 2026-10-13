import type { JsonObject, VarinExtensionServiceProvision } from '@varin/extension-contract';

export const VARIN_BUILTIN_COMPUTER_EXTENSION_ID = 'varin.builtin.computer';
export const COMPUTER_CAPABILITY = 'computer.use';
const string = { type: 'string', minLength: 1 };
const number = { type: 'number' };
const integer = { type: 'integer' };
const desktop = { desktopId: string };
const epoch = { automationEpoch: string };
const schema = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: 'object', additionalProperties: false, properties, required });
const browserFields = { ...desktop, ...epoch, tabId: string, port: { type: 'integer', minimum: 1, maximum: 65535 } };
const browserAction = schema({ kind: { enum: ['navigate', 'evaluate', 'click', 'type'] }, url: string, expression: string, x: number, y: number, text: { type: 'string' } }, ['kind']);
const officeFields = { doc: string, sheet: string, range: string };
const officeAction = schema({ ...officeFields, kind: { enum: ['write', 'insert', 'save', 'export'] },
  values: { type: 'array', items: { type: 'array', items: {} } }, text: { type: 'string' }, path: string, url: string, filter: string }, ['kind']);
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
  declaration('control', 'effect', 'Prepare this execution’s original control assignment, including the owning remote Host, before observing for input. A root can reserve an enabled desktop; children still need their root’s control grant. Then take a fresh observation/snapshot and use its epoch. This reserves control and returns state; it sends no application input.', schema(desktop)),
  declaration('observe', 'read', 'Observe one app/window through the original desktop owner. Keep observationId for element or screenshot-coordinate actions. Human handback requires a fresh observation. Automatic Agent handback is delivered through the original Computer event receipt.', schema({ ...desktop, app: string, window: { anyOf: [number, string] }, includeScreenshot: { type: 'boolean' }, observationId: string,
    offset: { type: 'integer', minimum: 0 }, textLimit: { anyOf: [{ type: 'integer', minimum: 1 }, { const: 'max' }] },
    maxTreeNodes: { type: 'integer', minimum: 1 }, maxTreeDepth: { type: 'integer', minimum: 1 } }, ['app'])),
  declaration('act', 'effect', 'Perform one action through the assigned physical desktop lane. Dispatch is not proof of application success. Never replay an unknown result. Persistent Node scripts can invoke this ordinary tool with tools.invoke under their original permission and Computer scopes. Native outputs preserve observation metadata in data and screenshots in typed media parts; scripts must explicitly emitImage a returned image to publish it in their own output.', schema({ ...desktop, ...epoch, action }, ['action'])),
  declaration('open', 'effect', 'Open exactly one URL, path or application on the assigned desktop’s machine. localhost and file paths refer to that machine. A dispatch receipt does not prove the application finished; never replay unknown input.', schema({ ...desktop, ...epoch, url: string, path: string, command: string, args: { type: 'array', items: { type: 'string' } } })),
  declaration('put', 'effect', 'Write base64 file bytes atomically into the managed desktop user’s home through its original owner. Returns the stored revision. Requires a control assignment; unsupported desktops report unavailable. Re-inspect an unknown result before retrying.', schema({ ...desktop, relativePath: string, contentBase64: { type: 'string' } }, ['relativePath', 'contentBase64'])),
  declaration('install', 'effect', 'Install recipe groups or packages in the assigned managed Linux desktop environment. Requires control. Reported package results retain failures; successful installation does not prove application usability.', schema({ ...desktop, groups: { type: 'array', items: string }, packages: { type: 'array', items: string } })),
  declaration('browser_read', 'read', 'Read the assigned desktop’s live Chromium session: status, tabs, snapshot, or screenshot. A screenshot is a typed media part. For input, call computer_control first, then take a fresh snapshot and keep its automationEpoch. These reads grant no control; upgrading an observation assignment can invalidate its old epoch.', { oneOf: [
    schema({ ...browserFields, op: { enum: ['status', 'tabs', 'snapshot'] }, limit: { type: 'integer', minimum: 1 } }, ['op']),
    schema({ ...browserFields, op: { const: 'act' }, act: schema({ kind: { const: 'screenshot' } }, ['kind']) }, ['op', 'act']),
  ] }),
  declaration('browser', 'effect', 'Launch or act in the assigned desktop’s live Chromium session through the original input lane. All evaluate expressions require control, even expressions described as read-only. After handback take a fresh snapshot. Unknown effects must not be replayed.', { oneOf: [
    schema({ ...browserFields, op: { const: 'launch' }, binary: string, profile: string }, ['op']),
    schema({ ...browserFields, op: { const: 'act' }, act: browserAction }, ['op', 'act']),
  ] }),
  declaration('office_read', 'read', 'Read status, open documents or document content from the assigned desktop’s live LibreOffice instance, including unsaved state. For writes, call computer_control first, then read the scene and keep its automationEpoch. This does not grant control; a changed assignment requires a fresh read.', { oneOf: [
    schema({ ...desktop, op: { enum: ['status', 'docs'] } }, ['op']),
    schema({ ...desktop, op: { const: 'act' }, act: schema({ ...officeFields, kind: { const: 'read' } }, ['kind']) }, ['op', 'act']),
  ] }),
  declaration('office', 'effect', 'Launch, open, write, insert, save or export in the assigned desktop’s live LibreOffice instance through its original input lane. Paths refer to that machine. Requires control; dispatch alone does not verify a document change.', { oneOf: [
    schema({ ...desktop, ...epoch, op: { const: 'launch' } }, ['op']),
    schema({ ...desktop, ...epoch, op: { const: 'open' }, path: string, url: string }, ['op']),
    schema({ ...desktop, ...epoch, op: { const: 'act' }, act: officeAction }, ['op', 'act']),
  ] }),
  declaration('evidence', 'read', 'Read the assigned desktop’s original operation journal. Entries are outcome and identity evidence, not proof of application success. Resume with nextSince; reads do not create a new execution.', schema({ ...desktop, since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } })),
  declaration('environment', 'read', 'Inspect this accepted Run’s frozen source/environment and Computer assignment/default. The operating desktop and file/process source are distinct. This read never changes placement or retargets accepted work.', schema({})),
  declaration('cancel', 'effect', 'Cancel the assigned desktop input lane and wait for its original release/drain evidence. Unknown release remains fenced; changing Host or starting a new helper cannot prove cleanup.', schema(desktop)),
  declaration('release', 'effect', 'Release this execution’s actual desktop assignment after original input cleanup. It does not change Computer permissions or the accepted Run source/environment.', schema(desktop)),
] as const;
