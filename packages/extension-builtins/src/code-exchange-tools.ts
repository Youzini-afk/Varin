import type { JsonObject, VarinExtensionServiceProvision } from '@varin/extension-contract';

export const VARIN_BUILTIN_CODE_EXCHANGE_EXTENSION_ID = 'varin.builtin.code-exchange';
export const CODE_EXCHANGE_CAPABILITY = 'collaboration.code';
const text: JsonObject = { type: 'string', minLength: 1 };
const files: JsonObject = { type: 'array', minItems: 1, items: { oneOf: [text, {
  type: 'object', additionalProperties: false, required: ['path', 'before', 'after'],
  properties: { path: text, before: { type: 'string' }, after: { type: 'string' } },
}] }, description: '文件路径，或精确片段 {path,before,after}。省略时交换来源的全部改动。' };
export const CODE_EXCHANGE_TOOL_DECLARATIONS: readonly VarinExtensionServiceProvision[] = [
  { id: 'varin.code.submit', version: 1, tool: {
    name: 'submit_code', operation: 'effect', completion: 'result', requirements: { source: 'physical', process: false },
    description: '将当前文件改动交给相关 Agent。target 填用途短码；省略时交给父任务。可选择文件或精确片段，返回实际应用结果与冲突。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { target: text, files }, },
    outputSchema: { type: 'object' },
  } },
  { id: 'varin.code.update', version: 1, tool: {
    name: 'update', operation: 'effect', completion: 'result', requirements: { source: 'physical', process: false },
    description: '将相关 Agent 的文件改动纳入当前工作副本，保留已有修改。source 填用途短码；省略时使用父任务。可选择文件或精确片段。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { source: text, files }, },
    outputSchema: { type: 'object' },
  } },
];
