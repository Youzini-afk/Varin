/**
 * A service access entry (execution-environment design §8.2). Keeps the
 * service's real location separate from the access path: a `forward` access
 * is a loopback listener on this Host that expires with it — never presented
 * as the service's own address or as a durable tunnel.
 */
export interface EnvironmentServiceAccess {
  id: string;
  /** Where the service actually listens. */
  service: { machineId: string; host: string; port: number };
  /** How to reach it. `direct` = the service's own address (no relay);
   * `forward` = an ephemeral loopback listener on this Host forwarding over
   * the authenticated Host↔Host channel. */
  access: {
    kind: "forward" | "direct";
    /** Machine the access address is valid on. */
    machineId: string;
    host: string;
    port: number;
    url: string;
  };
  /** Work Thread that owns this access (forwards are released with the Host). */
  threadId: string | null;
  createdAt: string;
}
