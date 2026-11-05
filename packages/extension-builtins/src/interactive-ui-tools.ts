import type { VarinExtensionServiceProvision } from '@varin/extension-contract';
export const VARIN_BUILTIN_INTERACTIVE_UI_EXTENSION_ID = 'varin.builtin.interactive-ui';
export const INTERACTIVE_UI_CAPABILITY = 'content.ui';
const file = { type: 'string', minLength: 1, description: 'Relative path inside this work.' };
export const INTERACTIVE_UI_TOOL_DECLARATIONS: readonly VarinExtensionServiceProvision[] = [{
  id: 'varin.ui.render', version: 1,
  tool: { name: 'render_ui', operation: 'effect', completion: 'result',
    description: 'Create or update a retained interactive work in chat. Supply exactly one of changes (HTML/CSS/JS files) or content (a varin-ui definition). Omit ref to create; use the real returned ui: reference to revise. Each complete call saves an atomic revision; HTML previews while streaming and scripts run after saving. Simple inline fragments can be written directly in assistant text. Read usage, input types, actions, object reference formats and HTML integration through tool_describe({"name":"render_ui","detail":"full","path":"/examples"}); individual examples are addressable as /examples/0, /examples/1, etc. Read saved source or a user view through resource_read kind ui.',
    disclosure: { namespace: 'media', summary: 'Create interactive works; discover inline choices, forms, object links and HTML integration.',
      aliases: ['varin-ui', 'interactive', 'choices', 'forms', '交互', '多选', '表单', '图表'] },
    // Usage lives in original tool metadata: tool_describe exposes it on demand,
    // while provider function declarations keep the compact description/schema.
    examples: [
      { description: 'Choice / inline syntax. Put the content object directly in a top-level varin-ui Markdown fence at the desired place in assistant text; surrounding prose remains Markdown. No render_ui call is needed for a first inline fragment. Omit multiple for single selection; multiple:true enables multi-select; allowOther:true adds free text alongside the options. Options may be nonempty strings or {key,label}. key and label are optional on a standalone field; label gives the user a useful heading. required is optional, false by default. Keep field/option keys and labels stable when their meaning remains unchanged across revisions. Omit action for local exploration; a string action generates editable text from its intent and the actual answers.',
        arguments: { content: { type: 'choice', label: 'What would you like to explore?', multiple: true, allowOther: true,
          options: [{ key: 'layout', label: 'Layout and reading flow' }, { key: 'interaction', label: 'Interaction and feedback' }], action: 'Continue with these areas' } } },
      { description: 'Inputs / grouped questions. inputType supports text (default), textarea, number, range and date. Optional placeholder and unit are text; min, max and positive step are numeric constraints where relevant. Range starts at min, or 0 if omitted. form.fields contains choice or input fields, each with a label or an explicit key; keys must be unique. The form action gathers answers once. Field actions inside a form are not rendered separately. Fields are optional unless their own required is true. These are input primitives: calculations, conditional layouts and custom widgets use HTML/JS.',
        arguments: { content: { type: 'form', label: 'Adjust the comparison', fields: [
          { type: 'input', key: 'name', label: 'Name', inputType: 'text', placeholder: 'Optional' },
          { type: 'input', key: 'notes', label: 'Additional thoughts', inputType: 'textarea' },
          { type: 'input', key: 'amount', label: 'Amount', inputType: 'number', unit: 'USD', min: 0, step: 0.01 },
          { type: 'input', key: 'weight', label: 'Weight', inputType: 'range', min: 0, max: 100, step: 1 },
          { type: 'input', key: 'date', label: 'Date', inputType: 'date' },
        ], action: { type: 'compose', label: 'Use these values' } } } },
      { description: 'Declarative actions. action can be a string or {type,label,ref?}. compose and reference prepare editable answer text with a fixed source; copy copies the current answer text. open requires a real ref and opens its existing owner. send presents a platform button explicitly labelled for sending, with an inspectable message preview, and sends only after the user clicks; it preserves the separate composer draft and follows the current queue/continuation behavior. Missing action means local-only exploration. Selection changes never send or change already filled draft text by themselves. A required field blocks a result action until answered.',
        arguments: { content: { type: 'choice', label: 'Detail', options: ['Overview', 'Detailed comparison'], required: true,
          action: { type: 'send', label: 'Continue with this level of detail' } } } },
      { description: 'Disclosure. label is the visible heading; content is Markdown shown on expansion. Opening or closing does not request a model. The state is retained with the view. This content is Markdown, not a container for nested varin-ui widgets.',
        arguments: { content: { type: 'disclosure', label: 'How the estimate was made', content: 'The estimate includes the selected items.\n\nActual costs can be adjusted in the inputs above.' } } },
      { description: 'Tabs. tabs is a nonempty array of {label,content,key?}; each content is Markdown. Stable unique keys preserve the selected view. Switching tabs is local. For interactive content inside tabs, use HTML/JS.',
        arguments: { content: { type: 'tabs', label: 'Ways to compare', tabs: [
          { key: 'summary', label: 'Overview', content: 'A short comparison.' },
          { key: 'details', label: 'Details', content: 'The supporting details.' },
        ] } } },
      { description: 'Embed. Replace the illustrative ref below with a real fixed revision returned by render_ui. A varin-ui fence with this content places the saved work at that position in the assistant reply. Repeated references in one turn share the complete inline view. Earlier replies retain their fixed revision; users can explicitly open the latest revision. To update a declarative work, call render_ui with its real ref and the new content definition; reuse meaningful keys to preserve compatible input. Rendering a new work just to embed another is usually unnecessary.',
        arguments: { content: { type: 'embed', ref: 'ui:actual-work@3' } } },
      { description: 'Native objects. Replace the illustrative ref with an actual task/Agent Thread ID or a current delegated operation ID; names, avatars and status come from the original owner. Other supported refs: the actual plan: receipt; existing varin-material:// or web source citations; file:<encodeURIComponent(originalCallId)>/<encodeURIComponent(actualPath)>; recovery:<originalOperationId>; usage:<encodeURIComponent(threadId)>/<encodeURIComponent(branchId)>. File refs open the existing editor, recovery refs open the recovery panel, and usage refs show current-branch context usage. These links do not themselves restore files, stop tasks or grant access. Use original identities from results, not invented IDs or states. Capturing an object reference records its observed label/state/time; it is not a new resource_read snapshot.',
        arguments: { content: { type: 'object', ref: 'thread:actual-task' } } },
      { description: 'HTML/JS. Relative work files support HTML, CSS, JS modules and data. Changes apply in order; an edit oldText must match once without overlap. entry defaults to index.html. media:<resourceId> embeds an image retained in this conversation. Theme variables: --background, --foreground, --muted, --muted-foreground, --primary, --primary-foreground, --border, --card, --card-foreground. Inline background is transparent by default; a custom palette should supply both foreground and background. Import {install,button,field,status} from @varin/ui for optional bundled controls; call install() to apply its styles. d3 and chart.js/auto imports load pinned network versions when needed. Layout, computation and presentation remain authored in HTML/CSS/JS. window.varinUI.state supplies initial business state; await saveState(value) confirms persistence, and setContext(value) supplies data for discussion. compose({text,includeContext?}) fills an editable draft and returns {status:"filled",updated}; it never sends. requestActions([{key,type,label,text?,ref?,includeContext?}]) presents platform buttons and returns {status:"presented"}. Types: compose, reference, copy, open, send. compose/copy/send need readable text; open needs a real object ref. reference adds a captured result or resolved object to the composer. Actions require unique keys. Send waits for the user to click its platform button; page startup, timers and restored state cannot send. Values and choices can stay entirely local; custom calculations need no model call.',
        arguments: { title: 'Adjust a value', changes: [{ op: 'write', file: 'index.html', text: '<label class="varin-field">Amount<input id="amount" type="number" value="0"></label>\n<script type="module">\nimport { install } from "@varin/ui";\ninstall();\nconst api = window.varinUI;\nconst input = document.getElementById("amount");\ninput.value = api.state?.amount ?? "0";\nconst update = () => {\n  api.setContext({ amount: input.value });\n  return api.requestActions([{ key: "use", type: "compose", label: "Use this amount", text: "Use amount: " + input.value, includeContext: true }]);\n};\ninput.addEventListener("input", () => { api.saveState({ amount: input.value }).catch(console.error); update().catch(console.error); });\nawait update();\n</script>' }] } },
    ],
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      ref: { type: 'string' }, title: { type: 'string' }, entry: file,
      content: { type: 'object', description: 'One varin-ui definition; also valid in an assistant-text varin-ui fence. Type-specific fields and actions are documented in tool_describe examples. Use content OR changes.',
        required: ['type'], properties: {
          type: { type: 'string', enum: ['choice', 'input', 'form', 'disclosure', 'tabs', 'embed', 'object'] },
          key: { type: 'string', description: 'Optional stable key when revising the same interaction.' },
          label: { type: 'string', description: 'Visible heading or field label.' },
          action: { description: 'Optional result action: text fills a draft; an object specifies type, label and optional ref.', anyOf: [{ type: 'string' }, { type: 'object', required: ['type', 'label'], properties: {
            type: { type: 'string', enum: ['compose', 'reference', 'copy', 'open', 'send'] }, label: { type: 'string' }, ref: { type: 'string' },
          }, additionalProperties: true }] },
        }, additionalProperties: true },
      changes: { type: 'array', items: { oneOf: [
        { type: 'object', additionalProperties: false, properties: { file, op: { enum: ['write', 'append'] }, text: { type: 'string' } }, required: ['file', 'op', 'text'] },
        { type: 'object', additionalProperties: false, properties: { file, op: { const: 'edit' }, edits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } }, required: ['oldText', 'newText'] } } }, required: ['file', 'op', 'edits'] },
        { type: 'object', additionalProperties: false, properties: { file, op: { const: 'delete' } }, required: ['file', 'op'] },
      ] } },
    } }, outputSchema: { type: 'object' },
  },
}];
