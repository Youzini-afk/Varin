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
  declaration('request', 'effect', 'Request a desktop assignment from the root task. Returns a pending requestId; use computer_wait for the decision.', schema({ ...desktop, access: { enum: ['observe', 'control'] }, reason: string }, ['access', 'reason'])),
  declaration('access', 'read', 'List desktop requests and current assignments for this task family.', schema({})),
  declaration('grant', 'effect', 'As the root task, grant a pending child desktop request. Existing controllers must release first.', schema({ requestId: string }, ['requestId'])),
  declaration('deny', 'effect', 'As the root task, deny a pending child desktop request with an optional reason.', schema({ requestId: string, reason: string }, ['requestId'])),
  declaration('wait', 'read', 'Wait for the decision on your desktop requestId. Cancelling the wait leaves the request intact.', schema({ requestId: string }, ['requestId']), true),
  declaration('list', 'read', 'List computers, desktops and reported capabilities. Children must request a desktop assignment before use.', schema({})),
  declaration('prepare', 'effect', 'Prepare a managed Linux desktop on this Host or a saved connection. Requires control and may install desktop components. Returns readiness and setup results.', schema({ connectionId: string, ...epoch, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } })),
  declaration('desktop_lifecycle', 'effect', 'Start or stop an assigned managed desktop session using its current automationEpoch. Take a fresh observation after the transition.', schema({ ...desktop, ...epoch, action: { enum: ['start', 'stop'] } }, ['action'])),
  declaration('artifact', 'effect', 'Register the current revision of a managed desktop home file as this real Thread’s Computer artifact. The existing Bot work and artifact download consumers can read that exact revision. Requires the desktop assignment; changed file or Host identity cannot silently replace it.', schema({ ...desktop, relativePath: string }, ['relativePath'])),
  declaration('apps', 'read', 'List applications with visible or minimized windows. Filter by app name, PID or window title with query; includeHidden includes background windows.', schema({ ...desktop, query: string, includeHidden: { type: 'boolean' } })),
  declaration('control', 'effect', 'Acquire control of a desktop, then take a fresh observation before input. Children require a root grant. Returns the current automationEpoch.', schema(desktop)),
  declaration('observe', 'read', 'Read an app or window and optionally capture its image. Use the returned observationId for actions. Take a fresh observation after human handback.', schema({ ...desktop, app: string, window: { anyOf: [number, string] }, includeScreenshot: { type: 'boolean' }, observationId: string,
    offset: { type: 'integer', minimum: 0 }, textLimit: { anyOf: [{ type: 'integer', minimum: 1 }, { const: 'max' }] },
    maxTreeNodes: { type: 'integer', minimum: 1 }, maxTreeDepth: { type: 'integer', minimum: 1 } }, ['app'])),
  declaration('act', 'effect', 'Act on an assigned desktop using its current automationEpoch and observationId. Verify the result with a new observation. From scripts, forward image parts explicitly with emitImage.', schema({ ...desktop, ...epoch, action }, ['action'])),
  declaration('open', 'effect', 'Open exactly one URL, path or application on the assigned desktop’s machine. localhost and file paths refer to that machine. A dispatch receipt does not prove the application finished; never replay unknown input.', schema({ ...desktop, ...epoch, url: string, path: string, command: string, args: { type: 'array', items: { type: 'string' } } })),
  declaration('put', 'effect', 'Write base64 file bytes atomically into the managed desktop user’s home through its original owner. Returns the stored revision. Requires a control assignment; unsupported desktops report unavailable. Re-inspect an unknown result before retrying.', schema({ ...desktop, relativePath: string, contentBase64: { type: 'string' } }, ['relativePath', 'contentBase64'])),
  declaration('install', 'effect', 'Install recipe groups or packages in the assigned managed Linux desktop environment. Requires control. Reported package results retain failures; successful installation does not prove application usability.', schema({ ...desktop, groups: { type: 'array', items: string }, packages: { type: 'array', items: string } })),
  declaration('browser_read', 'read', 'Read live Chromium status, tabs, page snapshot or screenshot. Before input, acquire computer_control and take a fresh snapshot for its automationEpoch.', { oneOf: [
    schema({ ...browserFields, op: { enum: ['status', 'tabs', 'snapshot'] }, limit: { type: 'integer', minimum: 1 } }, ['op']),
    schema({ ...browserFields, op: { const: 'act' }, act: schema({ kind: { const: 'screenshot' } }, ['kind']) }, ['op', 'act']),
  ] }),
  declaration('browser', 'effect', 'Launch or act in live Chromium. Requires computer_control and the current automationEpoch, including evaluate. Take a fresh snapshot after human handback.', { oneOf: [
    schema({ ...browserFields, op: { const: 'launch' }, binary: string, profile: string }, ['op']),
    schema({ ...browserFields, op: { const: 'act' }, act: browserAction }, ['op', 'act']),
  ] }),
  declaration('office_read', 'read', 'Read live LibreOffice status, documents and unsaved content. Before writing, acquire computer_control and read the current document state.', { oneOf: [
    schema({ ...desktop, op: { enum: ['status', 'docs'] } }, ['op']),
    schema({ ...desktop, op: { const: 'act' }, act: schema({ ...officeFields, kind: { const: 'read' } }, ['kind']) }, ['op', 'act']),
  ] }),
  declaration('office', 'effect', 'Launch, open, edit, save or export a live LibreOffice document. Requires control and the current automationEpoch. Paths refer to the assigned desktop.', { oneOf: [
    schema({ ...desktop, ...epoch, op: { const: 'launch' } }, ['op']),
    schema({ ...desktop, ...epoch, op: { const: 'open' }, path: string, url: string }, ['op']),
    schema({ ...desktop, ...epoch, op: { const: 'act' }, act: officeAction }, ['op', 'act']),
  ] }),
  declaration('evidence', 'read', 'Read the desktop operation journal. Continue with nextSince. Inspect the application separately to verify its state.', schema({ ...desktop, since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } })),
  declaration('environment', 'read', 'Read the file/process source and Computer assignment. They may refer to different machines.', schema({})),
  declaration('cancel', 'effect', 'Cancel desktop input and wait for the original input lane to drain. An unknown release remains reserved.', schema(desktop)),
  declaration('release', 'effect', 'Release the desktop assignment after input cleanup completes.', schema(desktop)),
] as const;
