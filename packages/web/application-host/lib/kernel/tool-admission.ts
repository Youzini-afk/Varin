/** A trusted local owner may report a short rejection marker. Never wrap remote error text. */
export class HostToolAdmissionError extends Error {
  constructor(readonly code: string) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(code)) throw new Error('host_tool_admission_marker_invalid');
    super(code);
    this.name = 'HostToolAdmissionError';
  }
}
