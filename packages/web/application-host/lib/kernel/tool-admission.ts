/** A trusted local owner may report a rejection code and user-facing explanation. */
export class HostToolAdmissionError extends Error {
  constructor(readonly code: string, message = code) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(code)) throw new Error('host_tool_admission_marker_invalid');
    super(message);
    this.name = 'HostToolAdmissionError';
  }
}
