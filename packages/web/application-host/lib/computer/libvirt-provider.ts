/**
 * libvirt provider for BC7 — drives `virsh` against a configured connection
 * URI (`qemu:///system`, `qemu+ssh://user@host/system`, …). All domain
 * identity is keyed on the real domain UUID; a create is idempotent — an
 * existing domain of the same name is adopted, never duplicated, and a lost
 * response is resolved by querying the hypervisor rather than re-creating.
 */
import { HarnessServiceError } from "../harness/service-error.js";
import type {
  ComputerVmProviderConfig,
  ComputerVmState,
} from "@varin/protocol";
import type {
  VmCreateOutcome,
  VmCreateSpec,
  VmExec,
  VmProvider,
  VmProviderDomain,
  VmProvisionJournalEntry,
} from "./vm-provider.js";

const STATE_MAP: Record<string, ComputerVmState> = {
  "running": "running",
  "paused": "paused",
  "shut off": "shutoff",
  "shutoff": "shutoff",
  "crashed": "crashed",
  "idle": "running",
  "in shutdown": "running",
  "pmsuspended": "paused",
};

const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function createLibvirtProvider(
  config: ComputerVmProviderConfig,
  exec: VmExec,
): VmProvider {
  const pool = config.storagePool?.trim() || "default";
  const network = config.network?.trim() || "default";

  const virsh = async (args: string[], expectSuccess = true, stdin?: string): Promise<string> => {
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await exec("virsh", ["-c", config.uri, ...args], stdin !== undefined ? { stdin } : undefined);
    } catch (error) {
      throw new HarnessServiceError(
        "unavailable",
        `virsh is not usable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (expectSuccess && result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `virsh exited ${result.code}`;
      throw new HarnessServiceError("unavailable", `virsh ${args[0] ?? ""} failed: ${detail}`);
    }
    return result.stdout;
  };

  const parseState = (raw: string): ComputerVmState => {
    const key = raw.trim().toLowerCase();
    return STATE_MAP[key] ?? (key ? "unknown" : "unknown");
  };

  /** Resolve a domain name to its UUID, or null when it does not exist. */
  const domainUuidFor = async (name: string): Promise<string | null> => {
    const out = await virsh(["domuuid", name], false);
    const uuid = out.trim();
    return /^[0-9a-fA-F-]{32,36}$/.test(uuid) ? uuid : null;
  };

  const domainState = async (domainUuid: string): Promise<ComputerVmState> => {
    const out = await virsh(["domstate", domainUuid]);
    return parseState(out);
  };

  const listDomains = async (): Promise<VmProviderDomain[]> => {
    const out = await virsh(["list", "--all", "--uuid", "--name"]);
    // Columns: uuid  name — state comes from a second pass only for entries we
    // actually manage; catalog refresh calls domainState per binding instead.
    return out.split("\n").flatMap((line) => {
      const match = line.trim().match(/^([0-9a-fA-F-]{32,36})\s+(.+)$/);
      if (!match) return [];
      return [{ domainUuid: match[1]!, name: match[2]!.trim(), state: "unknown" as const }];
    });
  };

  const domainXml = (spec: VmCreateSpec, volumePath: string): string => {
    const name = xmlEscape(spec.name);
    return [
      `<domain type='kvm'>`,
      `  <name>${name}</name>`,
      `  <memory unit='MiB'>${spec.memoryMiB}</memory>`,
      `  <vcpu>${spec.vcpus}</vcpu>`,
      `  <os><type arch='x86_64' machine='pc-q35-8.2'>hvm</type></os>`,
      `  <devices>`,
      `    <disk type='volume' device='disk'>`,
      `      <driver name='qemu' type='qcow2'/>`,
      `      <source pool='${xmlEscape(pool)}' volume='${xmlEscape(volumePath)}'/>`,
      `      <target dev='vda' bus='virtio'/>`,
      `    </disk>`,
      `    <interface type='network'>`,
      `      <source network='${xmlEscape(network)}'/>`,
      `      <model type='virtio'/>`,
      `    </interface>`,
      `    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>`,
      `    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>`,
      `    <video><model type='virtio' heads='1'/></video>`,
      `  </devices>`,
      `</domain>`,
    ].join("\n");
  };

  const provider: VmProvider = {
    config,

    async probe() {
      try {
        const out = await virsh(["version"]);
        const versionLine = out.split("\n").find((line) => /hypervisor/i.test(line)) ?? out.split("\n")[0];
        return { available: true, detail: versionLine?.trim() || "connected" };
      } catch (error) {
        return {
          available: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    listDomains,
    domainState,

    async create(spec: VmCreateSpec): Promise<VmCreateOutcome> {
      if (!namePattern.test(spec.name)) {
        throw new HarnessServiceError(
          "invalid-params",
          `VM name must match ${namePattern} (got ${JSON.stringify(spec.name)})`,
        );
      }
      const steps: VmProvisionJournalEntry[] = [];
      const step = (entry: VmProvisionJournalEntry) => steps.push(entry);

      // Idempotency: resolve the name first — a lost response must not
      // duplicate a domain.
      const existing = await domainUuidFor(spec.name);
      if (existing) {
        step({ step: "resolve", status: "done", detail: `existing domain ${existing}` });
        const volOut = await virsh(["domblklist", existing], false);
        const volumePaths = [...volOut.matchAll(/\S+\.qcow2/g)].map((m) => m[0]);
        return { ok: true, domainUuid: existing, volumePaths, steps, adopted: true };
      }
      step({ step: "resolve", status: "done", detail: "no existing domain" });

      const volumeName = `${spec.name}.qcow2`;
      const volumePaths = [volumeName];
      try {
        if (spec.baseImage) {
          // Clone the prepared base image so user data never lands on it.
          await virsh(["vol-clone", spec.baseImage, volumeName, "--pool", pool]);
          step({ step: "volume", status: "done", detail: `${pool}/${volumeName} cloned from ${spec.baseImage}` });
        } else {
          await virsh([
            "vol-create-as", pool, volumeName, `${spec.diskGiB}G`,
            "--format", "qcow2",
          ]);
          step({ step: "volume", status: "done", detail: `${pool}/${volumeName}` });
        }
      } catch (error) {
        step({
          step: "volume",
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
        // A failed allocation may still leave a partial volume behind —
        // attempt removal of OUR named volume and record the real result.
        try {
          await virsh(["vol-delete", "--pool", pool, volumeName]);
          step({ step: "cleanup", status: "done", detail: `${pool}/${volumeName}` });
        } catch (cleanupError) {
          step({
            step: "cleanup",
            status: "failed",
            detail: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
        return { ok: false, volumePaths: [], steps, error: `VM create failed at volume: ${steps.find((entry) => entry.step === "volume" && entry.status === "failed")?.detail}` };
      }

      // Domain XML rides stdin via virsh's `/dev/stdin` convention — no
      // host-side temp file is needed.
      let defined = false;
      try {
        await virsh(["define", "/dev/stdin"], true, domainXml(spec, volumeName));
        defined = true;
      } catch (error) {
        step({
          step: "define",
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (!defined) {
        // Define never ran — the volume we allocated is safe to remove.
        try {
          await virsh(["vol-delete", "--pool", pool, volumeName]);
          step({ step: "cleanup", status: "done", detail: `${pool}/${volumeName}` });
        } catch (cleanupError) {
          step({
            step: "cleanup",
            status: "failed",
            detail: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
        return { ok: false, volumePaths: [], steps, error: `VM create failed at define: ${steps.find((entry) => entry.status === "failed")?.detail}` };
      }
      const uuid = await domainUuidFor(spec.name);
      if (!uuid) {
        // The domain may be defined — its disk is NOT garbage. Report the
        // ambiguity honestly; the next create will adopt by name.
        step({
          step: "define",
          status: "failed",
          detail: "define returned but domuuid lookup failed — domain may exist; volume retained",
        });
        return { ok: false, volumePaths, steps, error: "VM create failed at define: UUID unresolved" };
      }
      step({ step: "define", status: "done", detail: uuid });
      return { ok: true, domainUuid: uuid, volumePaths, steps };
    },

    async start(domainUuid: string) {
      await virsh(["start", domainUuid]);
    },

    async shutdown(domainUuid: string) {
      // ACPI request — a guest without acpi/agent support ignores it; the
      // reported state stays honest because callers re-read domainState.
      await virsh(["shutdown", domainUuid]);
    },

    async reboot(domainUuid: string) {
      const state = await domainState(domainUuid);
      if (state === "shutoff") {
        // `virsh reboot` fails on a shutoff domain; the honest equivalent is
        // start — callers asked for "running again", not a noop error.
        await virsh(["start", domainUuid]);
        return;
      }
      await virsh(["reboot", domainUuid]);
    },

    async delete(domainUuid: string, volumePaths: string[], deleteDisks: boolean) {
      const state = await domainState(domainUuid);
      if (state === "running" || state === "paused") {
        await virsh(["destroy", domainUuid]);
      }
      await virsh(["undefine", domainUuid]);
      if (deleteDisks) {
        for (const volumePath of volumePaths) {
          // Strict: a failed disk removal must surface, not masquerade as a
          // complete delete — the caller can retry with the same record.
          await virsh(["vol-delete", "--pool", pool, volumePath]);
        }
      }
    },
  };
  return provider;
}
