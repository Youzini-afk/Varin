export interface KernelTransportDiagnostic {
  stage: string;
  kind: string;
  osError: number | null;
  reason: string | null;
}
const prefix = '[VarinKernelTransport] ';
const stages = new Set(['control-read', 'control-write', 'data-read', 'data-write', 'body-encode', 'body-announce', 'body-decode']);

/** Keep only the native transport's content-free diagnostic contract. */
export function kernelDiagnosticReader(emit: (diagnostic: KernelTransportDiagnostic) => void) {
  // Native stages, ErrorKind names, i32 OS codes and static protocol reasons
  // fit within this line. Unrelated stderr is discarded, including long lines.
  const lineCapacity = 512;
  let tail = '';
  let overflow = false;
  return (chunk: Buffer | string) => {
    const input = tail + chunk.toString();
    let offset = 0;
    for (let end = input.indexOf('\n'); end !== -1; end = input.indexOf('\n', offset)) {
      const line = input.slice(offset, end).replace(/\r$/, '');
      offset = end + 1;
      const discarded = overflow || line.length > lineCapacity;
      overflow = false;
      if (discarded || !line.startsWith(prefix)) continue;
      try {
        const raw: unknown = JSON.parse(line.slice(prefix.length));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const value = raw as Record<string, unknown>;
        if (Object.keys(value).length !== 4 || typeof value.stage !== 'string' || !stages.has(value.stage)
          || typeof value.kind !== 'string' || !/^[A-Z][A-Za-z]{0,31}$/.test(value.kind)
          || !(value.osError === null || Number.isSafeInteger(value.osError))
          || !(value.reason === null || typeof value.reason === 'string' && /^[A-Za-z ]{1,80}$/.test(value.reason))) continue;
        emit({ stage: value.stage, kind: value.kind, osError: value.osError as number | null, reason: value.reason as string | null });
      } catch { /* Unstructured diagnostics are not safe log material. */ }
    }
    const remaining = input.slice(offset);
    if (remaining.length > lineCapacity) { tail = ''; overflow = true; }
    else tail = remaining;
  };
}
