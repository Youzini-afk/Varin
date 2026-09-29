/**
 * BC7 virtualization provider abstraction. A provider owns the real
 * lifecycle of `provider:"virtual"` machines; the computer service keeps the
 * catalog record and the create journal while every operation below talks to
 * the actual hypervisor (never a simulation).
 */
import type {
  ComputerVmProviderConfig,
  ComputerVmState,
  ComputerVmStep,
} from "@varin/protocol";
import { HarnessServiceError } from "../harness/service-error.js";

export interface VmProviderDomain {
  domainUuid: string;
  name: string;
  state: ComputerVmState;
}

export interface VmCreateSpec {
  name: string;
  memoryMiB: number;
  vcpus: number;
  diskGiB: number;
  baseImage?: string;
  /** A NoCloud seed ISO generated from this exact guest runtime recipe. */
  seedIsoFile?: string;
  /** Host-persisted creation identity, established before any provider mutation. */
  domainUuid?: string;
  /** Previously confirmed allocation, never inferred from a matching VM name. */
  volumePaths?: string[];
  checkpoint?: (outcome: VmCreateOutcome) => Promise<void>;
}

/**
 * Create outcome — a RESULT, not a throw: the journal must reach the
 * machine record even for a half-finished create so the next attempt can
 * resolve the real domain state instead of guessing.
 */
export interface VmCreateOutcome {
  ok: boolean;
  /** Present on success (or adoption); absent when define never completed. */
  domainUuid?: string;
  /** Volumes this call allocated — the only paths `delete` may remove. */
  volumePaths: string[];
  steps: VmProvisionJournalEntry[];
  /** True when an existing domain of the same name was adopted, not created. */
  adopted?: boolean;
  error?: string;
}

export type VmProvisionJournalEntry = Omit<ComputerVmStep, "at">;

/**
 * One command invocation against the provider CLI. Injectable so tests run a
 * scripted virsh without touching a real hypervisor.
 */
export type VmExec = (
  command: string,
  args: string[],
  options?: { stdin?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface VmProvider {
  readonly config: ComputerVmProviderConfig;
  /** Reachability probe — never throws; reports the real reason. */
  probe(): Promise<{ available: boolean; detail?: string }>;
  /** Live domain states keyed by domain UUID. */
  listDomains(): Promise<VmProviderDomain[]>;
  /** State of one domain; throws not-found when the UUID is gone. */
  domainState(domainUuid: string): Promise<ComputerVmState>;
  /** Stage a verified official cloud image into this creation's owned volume. */
  stageBaseImage?(input: { domainUuid: string; file: string; volumePaths: string[]; uploaded: boolean;
    checkpoint(volumePaths: string[]): Promise<void> }): Promise<string>;
  /** Replace this stopped domain's recorded NoCloud volume for a runtime upgrade. */
  upgradeSeed?(input: { domainUuid: string; isoFile: string; volumePaths: string[] }): Promise<void>;
  /**
   * Create a domain. Retries reconcile the caller's recorded UUID and confirmed
   * allocations. Same-name domains with another UUID remain foreign resources.
   * Returns the step journal even on failure — the caller
   * persists it before surfacing the error. Throws only for malformed
   * params, never for provider-side failure.
   */
  create(spec: VmCreateSpec): Promise<VmCreateOutcome>;
  start(domainUuid: string): Promise<void>;
  /** Graceful ACPI shutdown — the guest may refuse; callers see that. */
  shutdown(domainUuid: string): Promise<void>;
  reboot(domainUuid: string): Promise<void>;
  /**
   * Remove the domain definition. `volumePaths` are deleted only when
   * `deleteDisks` is set — persistent disks survive a default destroy.
   */
  delete(domainUuid: string, volumePaths: string[], deleteDisks: boolean): Promise<void>;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Parse the `computerVmProviders` settings field into provider configs. */
export const configuredVmProviders = (
  settings: Record<string, unknown>,
): ComputerVmProviderConfig[] => (
  (Array.isArray(settings.computerVmProviders) ? settings.computerVmProviders : [])
    .flatMap((entry): ComputerVmProviderConfig[] => {
      if (!entry || typeof entry !== "object") return [];
      const raw = entry as Record<string, unknown>;
      const id = asString(raw.id);
      const uri = asString(raw.uri);
      if (!id || !uri || raw.kind !== "libvirt") return [];
      return [{
        id,
        kind: "libvirt",
        uri,
        ...(asString(raw.label) ? { label: asString(raw.label)! } : {}),
        ...(asString(raw.storagePool) ? { storagePool: asString(raw.storagePool)! } : {}),
        ...(asString(raw.network) ? { network: asString(raw.network)! } : {}),
      }];
    })
);

export const vmUnavailable = (detail: string): HarnessServiceError =>
  new HarnessServiceError("unavailable", detail);
