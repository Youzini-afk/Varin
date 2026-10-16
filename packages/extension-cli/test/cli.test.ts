import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init.js";
import { buildProject } from "../src/build.js";
import { checkProject } from "../src/project.js";
import { testProject } from "../src/test-command.js";
import { runCli } from "../src/cli.js";
import { INIT_TEMPLATES } from "../src/templates.js";

const temporaryDirectories: string[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "varin-extension-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
};
after(async () => {
  await Promise.all(temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true })));
});

const exchangeProtocolFrame = async (script: string, message: unknown): Promise<Record<string, unknown>> => {
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      let buffer = Buffer.alloc(0);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
        child.kill();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`Protocol fixture did not respond: ${script}`))), 5_000);
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code) => {
        if (!settled) finish(() => reject(new Error(`Protocol fixture exited before responding (${code ?? "unknown"}): ${script}`)));
      });
      child.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"));
        if (!match) return;
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        finish(() => resolve(JSON.parse(buffer.subarray(start, start + length).toString("utf8")) as Record<string, unknown>));
      });
      child.stdin.write(Buffer.concat([
        Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8"),
        payload,
      ]));
    });
  } finally {
    child.kill();
    await exited;
  }
};

test("init writes a standalone managed Surface template and refuses overwrite", async () => {
  const root = await temporaryDirectory();
  const project = join(root, "sample");
  await initProject({ directory: project, id: "dev.example.sample", name: "Sample Extension" });
  const files = await readdir(project);
  assert.deepEqual(files.sort(), ["README.md", "package.json", "src", "tsconfig.json", "varin.extension.json"]);
  await assert.rejects(
    initProject({ directory: project, id: "dev.example.other", name: "Other" }),
    /non-empty target directory/,
  );
});

test("every generated template builds and passes its published author lifecycle", async (t) => {
  const root = await temporaryDirectory();
  // Resolve the already-installed author SDK just as an installed generated project would.
  await symlink(resolve(import.meta.dirname, "../node_modules"), join(root, "node_modules"), "junction");
  for (const template of INIT_TEMPLATES) {
    await t.test(template, async () => {
      const project = await initProject({
        directory: join(root, template), id: `dev.example.${template}`, name: `Example ${template}`, template,
      });
      const result = await testProject(project.directory);
      assert.equal(result.host, ["language", "debug", "test"].includes(template) ? "passed" : "skipped");
      assert.equal(result.surfaces.length, ["surface", "shell", "editor", "view"].includes(template) ? 1 : 0,
        "Surface templates must actually execute their generated entrypoint");
      assert.ok(result.surfaces.every(surface => surface.result === "passed"));
      assert.deepEqual((await checkProject(project.directory)).missingFiles, []);
      if (template === "language" || template === "debug") {
        const language = template === "language";
        const runtime = `runtime/${language ? "language-server" : "debug-adapter"}.mjs`;
        const metadata = JSON.parse(await readFile(join(project.directory, "package.json"), "utf8"));
        assert.ok(metadata.files.includes("runtime"), "published template must include its executable adapter");
        const response = await exchangeProtocolFrame(join(project.directory, runtime), language
          ? { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
          : { seq: 1, type: "request", command: "initialize", arguments: { clientID: "test" } });
        if (language) {
          assert.equal(response.jsonrpc, "2.0");
          assert.equal(response.id, 1);
          assert.ok(response.result);
        } else {
          assert.equal(response.type, "response");
          assert.equal(response.request_seq, 1);
          assert.equal(response.success, true);
        }
      }
    });
  }
});

test("check reports a valid contract and missing published output", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "dev.example.check", version: "1.0.0" }));
  await writeFile(join(root, "varin.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.check",
    version: "1.0.0",
    engines: { varin: "*" },
    entrypoints: {
      surfaces: [{ id: "main", file: "dist/main.cjs", mode: "managed", supports: ["web"] }],
    },
  }));
  const result = await checkProject(root);
  assert.deepEqual(result.missingFiles, ["dist/main.cjs"]);
});

test("build uses the manifest output path and test exercises lifecycle cleanup", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "dev.example.lifecycle",
    type: "module",
    version: "1.0.0",
    varin: { build: { entrypoints: {
      host: { source: "src/host.js" },
      isolated: { source: "src/isolated.js" },
      main: { source: "src/main.js" },
    } } },
  }));
  await writeFile(join(root, "varin.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.lifecycle",
    version: "1.0.0",
    engines: { varin: "*" },
    entrypoints: {
      host: { file: "dist/host.cjs", mode: "brokered" },
      surfaces: [
        { id: "main", file: "dist/main.cjs", mode: "managed", supports: ["web"] },
        { id: "isolated", file: "dist/isolated.js", mode: "isolated", isolation: "worker", supports: ["web"] },
        { id: "declarative", mode: "declarative", supports: ["web"] },
      ],
    },
    contributions: [{
      contractVersion: 1,
      data: { contract: "dev.example.static/v1" },
      entrypoint: "declarative",
      id: "dev.example.lifecycle.static",
      kind: "panel",
      supports: ["web"],
    }],
  }));
  await mkdirSource(root);
  const built = await buildProject(root);
  assert.deepEqual(built.outputs.map((output) => output.file), ["dist/host.cjs", "dist/main.cjs", "dist/isolated.js"]);
  const tested = await testProject(root);
  assert.deepEqual(tested.surfaces.map((surface) => surface.result), ["passed", "passed", "passed"]);
  assert.equal(tested.host, "passed");
});

test("CLI output modes preserve validation and emit script-safe results", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "dev.example.output", version: "1.0.0" }));
  await writeFile(join(root, "varin.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.output",
    version: "1.0.0",
    engines: { varin: "*" },
  }));

  const jsonLines: string[] = [];
  const jsonErrors: string[] = [];
  const jsonExit = await runCli(["check", root, "--json"], {
    error: (...values) => jsonErrors.push(values.join(" ")),
    log: (...values) => jsonLines.push(values.join(" ")),
  });
  assert.equal(jsonExit, 0);
  assert.equal(jsonErrors.length, 0);
  assert.equal(jsonLines.length, 1);
  assert.deepEqual(JSON.parse(jsonLines[0] as string), {
    command: "check",
    extensionId: "dev.example.output",
    incompatibleContributions: [],
    missingFiles: [],
    ok: true,
    referencedFiles: [],
    version: "1.0.0",
  });

  const quietLines: string[] = [];
  assert.equal(await runCli(["check", root, "--quiet"], {
    error: () => undefined,
    log: (...values) => quietLines.push(values.join(" ")),
  }), 0);
  assert.deepEqual(quietLines, ["ok dev.example.output@1.0.0 files:0"]);

  const failureLines: string[] = [];
  const failureErrors: string[] = [];
  assert.equal(await runCli(["check", join(root, "missing"), "--json"], {
    error: (...values) => failureErrors.push(values.join(" ")),
    log: (...values) => failureLines.push(values.join(" ")),
  }), 1);
  assert.equal(failureErrors.length, 0);
  assert.equal(failureLines.length, 1);
  const failure = JSON.parse(failureLines[0] as string) as { command: string; errors: string[]; ok: boolean };
  assert.equal(failure.command, "check");
  assert.equal(failure.ok, false);
  assert.match(failure.errors[0] as string, /does not exist/);

  await writeFile(join(root, "varin.extension.json"), JSON.stringify({
    schemaVersion: 2,
    id: "dev.example.output",
    version: "1.0.0",
    engines: { varin: "not-a-semver-range" },
  }));
  const quietFailureLines: string[] = [];
  const quietFailureErrors: string[] = [];
  assert.equal(await runCli(["check", root, "--quiet"], {
    error: (...values) => quietFailureErrors.push(values.join(" ")),
    log: (...values) => quietFailureLines.push(values.join(" ")),
  }), 1);
  assert.equal(quietFailureLines.length, 0);
  assert.equal(quietFailureErrors.length, 1);
  assert.doesNotMatch(quietFailureErrors[0] as string, /[\r\n]/);
  assert.equal(
    quietFailureErrors[0],
    "error 2 issues: schemaVersion must be 1; engines.varin must be a valid SemVer range",
  );
});

test("check reports incompatible contributions for unknown contract version", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "dev.example.incompat",
    version: "1.0.0",
  }));
  await writeFile(join(root, "varin.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.incompat",
    version: "1.0.0",
    engines: { varin: ">=0.2.0" },
    contributions: [{
      id: "dev.example.incompat.view",
      kind: "view",
      contractVersion: 99,
      data: {},
      supports: ["web"],
    }],
  }));

  const jsonLines: string[] = [];
  const jsonErrors: string[] = [];
  const exit = await runCli(["check", root, "--json"], {
    error: (...values) => jsonErrors.push(values.join(" ")),
    log: (...values) => jsonLines.push(values.join(" ")),
  });
  assert.equal(exit, 1);
  assert.equal(jsonErrors.length, 0);
  const result = JSON.parse(jsonLines[0] as string) as {
    incompatibleContributions: Array<{ id: string; kind: string; contractVersion: number }>;
    ok: boolean;
  };
  assert.equal(result.ok, false);
  assert.equal(result.incompatibleContributions.length, 1);
  assert.equal(result.incompatibleContributions[0]!.kind, "view");
  assert.equal(result.incompatibleContributions[0]!.contractVersion, 99);
  assert.equal(result.incompatibleContributions[0]!.id, "dev.example.incompat.view");
});

test("check reports when validation errors for shell and transition-scene", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "dev.example.when",
    version: "1.0.0",
  }));
  await writeFile(join(root, "varin.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { varin: ">=0.2.0" },
    contributions: [
      {
        id: "dev.example.when.shell",
        kind: "shell",
        contractVersion: 1,
        data: {
          contract: "varin-workbench-shell/v1",
          seams: { web: { replacementTargets: ["workbench.editor"], slots: [] } },
        },
        supports: ["web"],
        replacement: { target: "workbench.shell" },
        when: { op: "defined", key: "editorIsOpen" },
      },
      {
        id: "dev.example.when.view",
        kind: "view",
        contractVersion: 1,
        data: {},
        supports: ["web"],
        when: { op: "defined", key: "editorIsOpen" },
      },
    ],
  }));

  const jsonLines: string[] = [];
  const jsonErrors: string[] = [];
  const exit = await runCli(["check", root, "--json"], {
    error: (...values) => jsonErrors.push(values.join(" ")),
    log: (...values) => jsonLines.push(values.join(" ")),
  });
  assert.equal(exit, 1);
  const result = JSON.parse(jsonLines[0] as string) as {
    errors: string[];
    ok: boolean;
  };
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("when") && e.includes("shell")));
});

const mkdirSource = async (root: string): Promise<void> => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "host.js"), `export default { activate(context) { context.effect(() => undefined); } };\n`);
  await writeFile(join(root, "src", "main.js"), `export default { activate(context) { context.onDispose(() => undefined); } };\n`);
  await writeFile(join(root, "src", "isolated.js"), `export default { activate(context) { context.effect(() => undefined); } };\n`);
};
