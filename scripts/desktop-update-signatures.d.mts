export function canonicalJson(value: unknown): string;
export function metadataBytes(document: Record<string, unknown>): Buffer;
export function verifyMinisign(bytes: Uint8Array, signature: string, publicKey: string, options?: { version?: string }): true;
export function verifySignedMetadata<T extends Record<string, unknown>>(document: T, publicKey: string): T;
