import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const extensionArgument = process.argv[2];
if (!extensionArgument) {
  throw new Error("Usage: npm run smoke:extension -- <absolute-extension-entry>");
}

const extensionPath = resolve(extensionArgument);
await access(extensionPath);
const root = await mkdtemp(join(tmpdir(), "varin-extension-smoke-"));
const agentDir = join(root, "agent");
const workspace = join(root, "workspace");
const projectConfigDir = join(workspace, ".pi");
process.env.PI_CODING_AGENT_DIR = agentDir;

await mkdir(projectConfigDir, { recursive: true });
await writeFile(
  join(projectConfigDir, "settings.json"),
  `${JSON.stringify({ extensions: [extensionPath] }, null, 2)}\n`,
);

const { SessionHost } = await import("../packages/pi-host/dist/index.js");
const events = [];
const host = new SessionHost({
  agentDir,
  emit: (event, data) => events.push({ data, event }),
  projectTrustOverride: true,
});

try {
  const snapshot = await host.create(workspace);
  const commands = host.listCommands(snapshot.sessionId);
  const mcpConfig = await host.mcpConfigSnapshot();
  const failures = events.filter(
    (entry) =>
      entry.event === "host.error" || (entry.event === "host.log" && entry.data?.level === "error"),
  );
  if (failures.length > 0) {
    throw new Error(`Extension load failed:\n${JSON.stringify(failures, null, 2)}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        commands: commands.map((command) => command.name),
        entry: extensionPath,
        eventCount: events.length,
        ...(mcpConfig.provider.state === "unavailable" ? {} : { mcpConfig }),
        name: basename(extensionPath),
        sessionId: snapshot.sessionId,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await host.dispose();
  await rm(root, { force: true, recursive: true });
}
