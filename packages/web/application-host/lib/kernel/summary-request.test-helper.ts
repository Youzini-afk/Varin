/** Identify the summarizer by its dedicated read capability, independently of prompt wording. */
export function isSummaryRequest(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.some(tool =>
    tool !== null && typeof tool === 'object' && tool.name === 'summary_read');
}
