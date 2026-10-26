import type { VarinExtensionServiceProvision } from '@varin/extension-contract';
export const VARIN_BUILTIN_INTERACTIVE_UI_EXTENSION_ID = 'varin.builtin.interactive-ui';
export const INTERACTIVE_UI_CAPABILITY = 'content.ui';
const file = { type: 'string', minLength: 1, description: 'Relative path inside this work.' };
export const INTERACTIVE_UI_TOOL_DECLARATIONS: readonly VarinExtensionServiceProvision[] = [{
  id: 'varin.ui.render', version: 1,
  tool: { name: 'render_ui', operation: 'effect', completion: 'result',
    description: 'Create or update interactive HTML content in chat. Omit ref to create; use the returned ui: reference to continue. Each complete call saves one atomic revision; preview streams while writing. Relative files support HTML, CSS, JS modules and data; media:<resourceId> embeds a retained image from this conversation. CSS variables --background, --foreground, --muted, --muted-foreground, --primary, --primary-foreground, --border, --card and --card-foreground follow the app theme. Inline content defaults to a transparent background; custom palettes retain their own foregrounds and backgrounds. Changes run in order; edits in one step match its original text uniquely without overlap. Read saved source or the user’s view with resource_read kind ui. In the page, window.varinUI.state is initial JSON state, saveState(value) retains it, and setContext(value) supplies context for the host Continue action. Module imports d3 and chart.js/auto load pinned network versions on demand. Controls run locally. Scripts run after saving. No publish step is needed.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      ref: { type: 'string' }, title: { type: 'string' }, entry: file,
      changes: { type: 'array', items: { oneOf: [
        { type: 'object', additionalProperties: false, properties: { file, op: { enum: ['write', 'append'] }, text: { type: 'string' } }, required: ['file', 'op', 'text'] },
        { type: 'object', additionalProperties: false, properties: { file, op: { const: 'edit' }, edits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } }, required: ['oldText', 'newText'] } } }, required: ['file', 'op', 'edits'] },
        { type: 'object', additionalProperties: false, properties: { file, op: { const: 'delete' } }, required: ['file', 'op'] },
      ] } },
    }, required: ['changes'] }, outputSchema: { type: 'object' },
  },
}];
