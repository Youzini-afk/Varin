import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HostEvent, HostEventData } from "@varin/protocol";
import { SessionHost } from "../src/session-host.js";

describe("SessionHost Pi packages", () => {
  it("installs, reloads, reports, and removes a project-scoped local package", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-host-packages-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const packageRoot = join(root, "fixture-pi-package");
    await mkdir(cwd, { recursive: true });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "fixture-pi-package",
        version: "1.2.3",
        pi: { extensions: ["./index.ts"] },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(packageRoot, "index.ts"),
      `export default function (pi: any) {
  pi.registerCommand("fixture-package-command", {
    description: "Loaded from the project package",
    handler() {},
  });
}
`,
      "utf8",
    );
    const host = new SessionHost({
      agentDir,
      emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
        void event;
        void data;
      },
      projectTrustOverride: true,
    });

    try {
      const snapshot = await host.openCatalogContext(cwd);
      assert.deepEqual(host.listPackages(), []);

      const installed = await host.installPackage(packageRoot, "project");
      assert.equal(installed.name, "fixture-pi-package");
      assert.equal(installed.enabled, true);
      assert.equal(installed.scope, "project");
      assert.equal(installed.installed, true);
      assert.equal(installed.structured, false);
      assert.equal(installed.resolvedPath, packageRoot);
      assert.equal(installed.version, "1.2.3");
      const command = host.listCommands(snapshot.sessionId)
        .find((entry) => entry.name === "fixture-package-command");
      assert.equal(command?.source, "extension");
      assert.equal(command?.sourceInfo?.source, installed.source);
      assert.equal(command?.sourceInfo?.scope, "project");

      const disabled = await host.setPackageEnabled(installed.source, "project", false);
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.installed, true);
      assert.equal(
        host.listCommands(snapshot.sessionId)
          .some((entry) => entry.name === "fixture-package-command"),
        false,
      );
      const disabledSettings = JSON.parse(
        await readFile(join(cwd, ".pi", "settings.json"), "utf8"),
      ) as { packages?: Array<{ extensions?: string[]; source: string }> };
      assert.deepEqual(disabledSettings.packages?.[0]?.extensions, []);

      const reenabled = await host.setPackageEnabled(installed.source, "project", true);
      assert.equal(reenabled.enabled, true);
      assert.equal(
        host.listCommands(snapshot.sessionId)
          .some((entry) => entry.name === "fixture-package-command"),
        true,
      );

      const settings = JSON.parse(
        await readFile(join(cwd, ".pi", "settings.json"), "utf8"),
      ) as { packages?: string[] };
      assert.ok(settings.packages?.includes(installed.source));

      await rm(packageRoot, { force: true, recursive: true });
      const missing = host.listPackages().find((entry) => entry.source === installed.source);
      assert.equal(missing?.installed, false);
      assert.equal(missing?.resolvedPath, undefined);

      assert.equal(await host.removePackage(installed.source, "project"), true);
      assert.deepEqual(host.listPackages(), []);
      assert.equal(
        host.listCommands(snapshot.sessionId)
          .some((command) => command.name === "fixture-package-command"),
        false,
      );
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
