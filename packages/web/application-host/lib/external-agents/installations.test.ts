import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ExternalAgentSettings } from "@varin/application-client";
import { ExternalAgentInstaller } from "./installations.js";
import type { createKernelProcessService } from "../kernel/process-service.js";

async function fixture(aliasRoot = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "varin-install-"));
  let directory = root;
  if (aliasRoot) {
    const physical = path.join(root, "physical");
    await mkdir(physical);
    directory = path.join(root, "alias");
    await symlink(physical, directory, process.platform === "win32" ? "junction" : "dir");
  }
  let settings: ExternalAgentSettings = {
    revision: 1,
    defaultAgent: null,
    agents: [
      {
        id: "codex",
        name: "Codex",
        harness: "codex",
        command: "codex",
        args: [],
        enabled: true,
      },
    ],
  };
  let fail = false,
    hold: (() => Promise<void>) | undefined;
  const spawn = vi.fn(
    async (
      _command: string,
      args: readonly string[],
      options: { signal?: AbortSignal },
    ) => {
      const stdout = new PassThrough(),
        stderr = new PassThrough();
      let done!: () => void;
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        exitConfirmed: false,
        exitCode: null as number | null,
        completion: new Promise<void>((resolve) => {
          done = resolve;
        }),
        release: vi.fn(async () => {}),
      });
      const stop = (code: number) => {
        child.exitCode = code;
        child.exitConfirmed = true;
        stdout.end();
        stderr.end();
        done();
      };
      setTimeout(
        () =>
          void (async () => {
            if (args[0] === "view") {
              stdout.write('"1.2.3"');
              stop(0);
              return;
            }
            await hold?.();
            if (options.signal?.aborted) {
              stop(1);
              return;
            }
            if (fail) {
              stderr.write("upstream install failed");
              stop(1);
              return;
            }
            const prefix = args[args.indexOf("--prefix") + 1]!;
            const pkg = path.join(prefix, "node_modules", "@openai", "codex");
            const bin = path.join(prefix, "node_modules", ".bin");
            await mkdir(pkg, { recursive: true });
            await mkdir(bin, { recursive: true });
            await writeFile(
              path.join(pkg, "package.json"),
              JSON.stringify({ version: "1.2.3", bin: { codex: "bin.js" } }),
            );
            await writeFile(
              path.join(
                bin,
                `codex${process.platform === "win32" ? ".cmd" : ""}`,
              ),
              "fixture",
            );
            stop(0);
          })().catch((error) => {
            stderr.write(String(error));
            stop(1);
          }),
        0,
      );
      return child;
    },
  );
  const installer = new ExternalAgentInstaller({
    directory,
    spawn: spawn as unknown as ReturnType<
      typeof createKernelProcessService
    >["spawn"],
    fetch,
    executable: async () => ({ command: "npm", args: [], env: {} }),
    settings: async () => structuredClone(settings),
    configure: async (value, revision) => {
      expect(revision).toBe(settings.revision);
      settings = { ...settings, ...value, revision: revision + 1 };
    },
    removeProgram: (directory) =>
      rm(directory, { recursive: true, force: true }),
  });
  const complete = async () => {
    let state = await installer.request({ action: "state" });
    while (
      state.operations.some((operation) =>
        ["running", "cancelling"].includes(operation.status),
      )
    )
      state = await installer.request({
        action: "watch",
        after: state.revision,
      });
    return state.operations[0]!;
  };
  return {
    installer,
    spawn,
    complete,
    settings: () => settings,
    fail: () => {
      fail = true;
    },
    hold: (value: () => Promise<void>) => {
      hold = value;
    },
    disable: () => {
      settings.agents[0]!.enabled = false;
      settings.agents[0]!.availability = "disabled";
      settings.revision++;
    },
    close: async () => {
      await installer.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("activates a complete private generation and leaves it in place after a failed update", async () => {
  const f = await fixture(true);
  try {
    await f.installer.request({ action: "install", id: "codex" });
    const operation = await f.complete();
    expect(operation.status, operation.error).toBe("succeeded");
    const installed = f.settings().agents[0]!;
    expect(await f.installer.inspect(installed)).toMatchObject({
      version: "1.2.3",
    });
    expect(await readFile(installed.command, "utf8")).toBe("fixture");
    f.fail();
    await f.installer.request({ action: "install", id: "codex" });
    expect((await f.complete()).status).toBe("failed");
    expect(f.settings().agents[0]!.command).toBe(installed.command);
    expect(await readFile(installed.command, "utf8")).toBe("fixture");
  } finally {
    await f.close();
  }
});

it("preserves enable changes during installation and waits for native cancellation completion", async () => {
  const f = await fixture();
  let finish!: () => void;
  try {
    f.hold(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.installer.request({ action: "install", id: "codex" });
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.disable();
    finish();
    const operation = await f.complete();
    expect(operation.status, operation.error).toBe("succeeded");
    expect(f.settings().agents[0]!.enabled).toBe(false);
    let cancelled!: () => void;
    f.hold(
      () =>
        new Promise((resolve) => {
          cancelled = resolve;
        }),
    );
    await f.installer.request({ action: "install", id: "codex" });
    await vi.waitFor(() => expect(cancelled).toBeDefined());
    expect(
      (await f.installer.request({ action: "cancel", id: "codex" }))
        .operations[0]!.status,
    ).toBe("cancelling");
    cancelled();
    expect((await f.complete()).status).toBe("cancelled");
    expect(f.settings().agents[0]!.enabled).toBe(false);
  } finally {
    await f.close();
  }
});
