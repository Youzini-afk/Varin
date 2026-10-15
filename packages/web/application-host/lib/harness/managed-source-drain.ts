/** Local domain evidence that a failed call has left its original reader. This
 * class is never decoded from a network response or inferred from an error code. */
export class ManagedSourceDrainedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ManagedSourceDrainedError';
  }
}
