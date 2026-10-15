/** Read the receipt metadata block emitted by the Responses adapter's typed output path.
 * Other ordered text/media parts remain distinct protocol blocks; this helper never unwraps
 * opaque tool data or accepts the obsolete string-only wire representation. */
export function responsesMetadataText(output: unknown): string {
  if (!Array.isArray(output) || output.length === 0) throw new Error('Expected Responses output blocks');
  const first = output[0] as { type?: unknown; text?: unknown } | null;
  if (!first || first.type !== 'input_text' || typeof first.text !== 'string') {
    throw new Error('Expected the original Responses metadata text block');
  }
  return first.text;
}
