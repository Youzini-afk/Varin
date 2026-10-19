import type { ContextAgentDefinition } from '@varin/protocol';

/** Controlled native descriptor for Host/UI contract tests; native tests exercise the real prompt. */
export async function contextAgentDefinitionFixture(): Promise<ContextAgentDefinition> {
  return {
    instructions: 'Organize the supplied conversation.', systemSuffix: 'Return summary and retain as JSON.',
    request: 'Organize this conversation context.', budgetTemplate: 'Budget: {budget}. Tokenizer: {tokenizer}.',
    tools: [{ name: 'summary_read', version: '1', description: 'Read the frozen conversation.',
      schema: { type: 'object' }, output_schema: null, metadata: null }],
  };
}
