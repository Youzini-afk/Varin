import { describe, expect, it } from "vitest";
import { createLibvirtProvider } from "./libvirt-provider.js";
import type { ComputerVmProviderConfig } from "@varin/protocol";
import type { VmExec } from "./vm-provider.js";

const config: ComputerVmProviderConfig = {
  id: "hv1",
  kind: "libvirt",
  uri: "qemu:///system",
};

interface Call {
  command: string;
  args: string[];
  stdin?: string;
}

const fakeExec = (
  handler: (args: string[]) => { code?: number; stdout?: string; stderr?: string } | string
    | Promise<{ code?: number; stdout?: string; stderr?: string }>,
) => {
  const calls: Call[] = [];
  const exec: VmExec = async (command, args, options) => {
    calls.push({ command, args, ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) });
    // Strip the `-c <uri>` prefix for script matching.
    const scriptArgs = args.slice(2);
    const reply = await handler(scriptArgs);
    const shaped = typeof reply === "string" ? { stdout: reply } : reply;
    return { code: shaped.code ?? 0, stdout: shaped.stdout ?? "", stderr: shaped.stderr ?? "" };
  };
  return { exec, calls };
};

const scriptFor = (table: Record<string, { code?: number; stdout?: string; stderr?: string }>) =>
  (args: string[]) => {
    const key = args[0] ?? "";
    const entry = table[key];
    if (!entry) throw new Error(`unexpected virsh call: ${args.join(" ")}`);
    return entry;
  };

describe("libvirt provider (BC7)", () => {
  it("reports availability from a real `virsh version` probe", async () => {
    const { exec, calls } = fakeExec(scriptFor({
      version: { stdout: "Compiled against library: libvirt 10.0.0\nUsing library: libvirt 10.0.0\nUsing API: QEMU 10.0.0\nRunning hypervisor: QEMU 8.2.2\n" },
    }));
    const provider = createLibvirtProvider(config, exec);
    const probe = await provider.probe();
    expect(probe.available).toBe(true);
    expect(probe.detail).toContain("QEMU");
    expect(calls[0]).toMatchObject({ command: "virsh", args: ["-c", "qemu:///system", "version"] });
  });

  it("reports unavailable with the real error when virsh cannot connect", async () => {
    const { exec } = fakeExec(() => { throw new Error("spawn virsh ENOENT"); });
    const provider = createLibvirtProvider(config, exec);
    const probe = await provider.probe();
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain("ENOENT");
  });

  it("creates a domain: volume, define via stdin XML, UUID identity", async () => {
    // domuuid is called twice: first lookup fails, post-define resolves.
    let domuuidCalls = 0;
    const { exec, calls } = fakeExec((scriptArgs) => {
      if (scriptArgs[0] === "domuuid") {
        domuuidCalls += 1;
        return domuuidCalls === 1
          ? { code: 1, stdout: "", stderr: "error: failed to get domain 'alpha'" }
          : { code: 0, stdout: "9f8e7d6c-1111-2222-3333-444455556666\n", stderr: "" };
      }
      return scriptFor({
        "vol-create-as": { stdout: "Vol alpha.qcow2 created\n" },
        define: { stdout: "Domain alpha defined from /dev/stdin\n" },
      })(scriptArgs);
    });
    const provider = createLibvirtProvider(config, exec);
    const outcome = await provider.create({ name: "alpha", memoryMiB: 2048, vcpus: 2, diskGiB: 20 });
    expect(outcome.ok).toBe(true);
    expect(outcome.domainUuid).toBe("9f8e7d6c-1111-2222-3333-444455556666");
    expect(outcome.volumePaths).toEqual(["alpha.qcow2"]);
    expect(outcome.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "resolve:done", "volume:done", "define:done",
    ]);
    const defineCall = calls.find((c) => c.args.includes("define"));
    expect(defineCall?.stdin).toContain("<name>alpha</name>");
    expect(defineCall?.stdin).toContain("vol"); // disk source references the created volume
  });

  it("adopts an existing domain by name instead of duplicating it", async () => {
    const { exec, calls } = fakeExec(scriptFor({
      domuuid: { stdout: "aaaa0000-0000-0000-0000-0000000000aa\n" },
      domblklist: { stdout: " Target   Source\n--------------------\n vda      default/alpha.qcow2\n" },
    }));
    const provider = createLibvirtProvider(config, exec);
    const outcome = await provider.create({ name: "alpha", memoryMiB: 2048, vcpus: 2, diskGiB: 20 });
    expect(outcome.ok).toBe(true);
    expect(outcome.adopted).toBe(true);
    expect(outcome.domainUuid).toBe("aaaa0000-0000-0000-0000-0000000000aa");
    expect(calls.some((c) => c.args.includes("vol-create-as"))).toBe(false);
    expect(calls.some((c) => c.args.includes("define"))).toBe(false);
  });

  it("a failed define cleans up only the volume this call created", async () => {
    const { exec, calls } = fakeExec((scriptArgs) => {
      switch (scriptArgs[0]) {
        case "domuuid": return { code: 1, stdout: "", stderr: "no domain" };
        case "vol-create-as": return { code: 0, stdout: "Vol beta.qcow2 created\n", stderr: "" };
        case "define": return { code: 1, stdout: "", stderr: "invalid XML" };
        case "vol-delete": return { code: 0, stdout: "Vol beta.qcow2 deleted\n", stderr: "" };
        default: throw new Error(`unexpected ${scriptArgs.join(" ")}`);
      }
    });
    const provider = createLibvirtProvider(config, exec);
    const outcome = await provider.create({ name: "beta", memoryMiB: 2048, vcpus: 2, diskGiB: 20 });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("define");
    const steps = outcome.steps.map((s) => `${s.step}:${s.status}`);
    expect(steps).toContain("volume:done");
    expect(steps).toContain("define:failed");
    expect(steps).toContain("cleanup:done");
    expect(calls.some((c) => c.args.includes("vol-delete") && c.args.includes("beta.qcow2"))).toBe(true);
  });

  it("keeps the volume when define ran but the UUID could not be resolved", async () => {
    const { exec, calls } = fakeExec((scriptArgs) => {
      switch (scriptArgs[0]) {
        case "domuuid": return { code: 1, stdout: "", stderr: "no domain" };
        case "vol-create-as": return { code: 0, stdout: "Vol gamma.qcow2 created\n", stderr: "" };
        case "define": return { code: 0, stdout: "Domain gamma defined\n", stderr: "" };
        default: throw new Error(`unexpected ${scriptArgs.join(" ")}`);
      }
    });
    const provider = createLibvirtProvider(config, exec);
    const outcome = await provider.create({ name: "gamma", memoryMiB: 2048, vcpus: 2, diskGiB: 20 });
    expect(outcome.ok).toBe(false);
    // The domain may exist — deleting its disk would be destructive.
    expect(calls.some((c) => c.args.includes("vol-delete"))).toBe(false);
    expect(outcome.steps.some((s) => s.detail?.includes("volume retained"))).toBe(true);
  });

  it("shutdown is graceful ACPI and delete keeps disks by default", async () => {
    const { exec, calls } = fakeExec(scriptFor({
      domstate: { stdout: "running\n" },
      shutdown: { stdout: "Domain d is being shutdown\n" },
      destroy: { stdout: "Domain d destroyed\n" },
      undefine: { stdout: "Domain d has been undefined\n" },
    }));
    const provider = createLibvirtProvider(config, exec);
    await provider.shutdown("d");
    await provider.delete("d", ["x.qcow2"], false);
    expect(calls.some((c) => c.args.includes("destroy"))).toBe(true); // running → force off first
    expect(calls.some((c) => c.args.includes("vol-delete"))).toBe(false); // disks survive
  });

  it("delete with deleteDisks removes exactly the recorded volumes", async () => {
    const { exec, calls } = fakeExec(scriptFor({
      domstate: { stdout: "shut off\n" },
      undefine: { stdout: "undefined\n" },
      "vol-delete": { stdout: "deleted\n" },
    }));
    const provider = createLibvirtProvider(config, exec);
    await provider.delete("d", ["a.qcow2", "b.qcow2"], true);
    const deletes = calls.filter((c) => c.args.includes("vol-delete"));
    expect(deletes.map((c) => c.args[c.args.length - 1])).toEqual(["a.qcow2", "b.qcow2"]);
    expect(calls.some((c) => c.args.includes("destroy"))).toBe(false); // already off
  });
});
