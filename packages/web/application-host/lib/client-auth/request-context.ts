export interface VarinAuthenticatedClient extends Record<string, unknown> {
  allowedDirectories?: string[];
  capabilities?: string[];
  id: string;
  principalId?: string;
  label?: string;
  profile?: string;
}

export type VarinRequestAuthContext =
  | {
      client: VarinAuthenticatedClient;
      clientId: string;
      type: 'client';
      principalId?: string;
    }
  | {
    client?: VarinAuthenticatedClient;
    clientId?: string;
    token?: string;
    type: 'session';
    principalId?: string;
  };

declare global {
  // Express intentionally exposes this open namespace for application request metadata.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      __varinExternalAuditAttached?: boolean;
      varinAuth?: VarinRequestAuthContext;
    }
  }
}
