/** Probe the trusted local Host directly, independently of the renderer's selected remote Host. */
export async function checkLocalNativeRuntime(
  localOrigin: string | null | undefined,
  clientToken: string,
  request: typeof fetch = fetch,
): Promise<void> {
  if (!localOrigin) throw new Error('The local Application Host is unavailable. Restart Varin to retry.');
  const response = await request(`${localOrigin.replace(/\/+$/, '')}/api/threads/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(clientToken ? { Authorization: `Bearer ${clientToken}` } : {}) },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`The local native runtime is unavailable (${response.status}).`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error('The local Host did not return a native Thread catalog.');
}
