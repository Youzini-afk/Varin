#!/usr/bin/env node
import { buildProject } from "./build.js";
import { initProject } from "./init.js";
import { checkProject, formatContractError } from "./project.js";
import { testProject } from "./test-command.js";
import { isInitTemplate, type InitTemplate } from "./templates.js";
import { pathToFileURL } from "node:url";
import { CliOutput, type CliConsole } from "./cli-output.js";

const usage = `Usage:
  varin-extension init [dir] --id <extension-id> --name <display-name> [--template surface|shell|editor|view|language|debug|test]
  varin-extension check [dir]
  varin-extension build [dir]
  varin-extension test [dir]

Global output options:
  --quiet  Emit one concise result line
  --json   Emit one JSON value and no human-formatted output
`;

interface ParsedArgs {
  command: string | undefined;
  directory: string | undefined;
  help: boolean;
  id: string | undefined;
  json: boolean;
  name: string | undefined;
  quiet: boolean;
  template: InitTemplate | undefined;
}

const parseArgs = (args: string[]): ParsedArgs => {
  const result: ParsedArgs = {
    command: undefined,
    directory: undefined,
    help: false,
    id: undefined,
    json: false,
    name: undefined,
    quiet: false,
    template: undefined,
  };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--json") result.json = true;
    else if (value === "--quiet") result.quiet = true;
    else if (value === "--id" || value === "--name" || value === "--template") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      if (value === "--id") result.id = next;
      else if (value === "--name") result.name = next;
      else {
        if (!isInitTemplate(next)) throw new Error(`Unknown init template "${next}". Use surface, shell, editor, view, language, debug, or test.`);
        result.template = next;
      }
      index += 1;
      continue;
    }
    if (value === "--help" || value === "-h" || value === "--json" || value === "--quiet") continue;
    if (value.startsWith("--id=") || value.startsWith("--name=") || value.startsWith("--template=")) {
      const split = value.indexOf("=");
      const option = value.slice(0, split);
      const optionValue = value.slice(split + 1);
      if (!optionValue) throw new Error(`${option} requires a value`);
      if (option === "--id") result.id = optionValue;
      else if (option === "--name") result.name = optionValue;
      else {
        if (!isInitTemplate(optionValue)) throw new Error(`Unknown init template "${optionValue}". Use surface, shell, editor, view, language, debug, or test.`);
        result.template = optionValue;
      }
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    positional.push(value);
  }
  result.command = result.help ? "help" : positional.shift();
  if (positional.length > 1) throw new Error(`Unexpected arguments: ${positional.slice(1).join(" ")}`);
  result.directory = positional[0];
  if (result.json && result.quiet) throw new Error("--json and --quiet are mutually exclusive output modes");
  return result;
};

export const runCli = async (args: string[], output: CliConsole = console): Promise<number> => {
  let parsed: ParsedArgs | undefined;
  try {
    parsed = parseArgs(args);
    const cliOutput = new CliOutput({ json: parsed.json, quiet: parsed.quiet }, output);
    if (!parsed.command || parsed.command === "help") {
      cliOutput.success({
        human: [usage],
        json: { command: "help", usage },
        quiet: "varin-extension init|check|build|test",
      });
      return 0;
    }
    if (parsed.command === "init") {
      if (!parsed.id || !parsed.name) throw new Error("init requires both --id and --name; the command is non-interactive");
      const created = await initProject({
        ...(parsed.directory ? { directory: parsed.directory } : {}),
        id: parsed.id,
        name: parsed.name,
        ...(parsed.template ? { template: parsed.template } : {}),
      });
      cliOutput.success({
        human: [`Created Varin extension template in ${created.directory}`],
        json: {
          command: "init",
          directory: created.directory,
          displayName: parsed.name,
          extensionId: parsed.id,
          template: created.template,
        },
        quiet: `created ${created.directory}`,
      });
      return 0;
    }
    if (parsed.command === "check") {
      const result = await checkProject(parsed.directory);
      if (result.missingFiles.length > 0) {
        throw new Error(`Manifest is valid, but referenced entrypoint files are missing: ${result.missingFiles.join(", ")}. Run varin-extension build to create them.`);
      }
      const incompatibleLines = result.incompatibleContributions.map((item) => (
        `  ${item.id} (${item.kind} contractVersion ${item.contractVersion} is not supported; supported: ${item.supportedVersions.join(", ")})`
      ));
      const hasIncompatible = incompatibleLines.length > 0;
      const authorLines = result.authorDiagnostics.map(item => `  ${item.contributionId}: ${item.message}`);
      cliOutput.success({
        human: [
          hasIncompatible || authorLines.length
            ? `WARN: ${result.project.manifest.id}@${result.project.manifest.version} (${result.referencedFiles.length} referenced entrypoint file${result.referencedFiles.length === 1 ? "" : "s"})`
            : `OK: ${result.project.manifest.id}@${result.project.manifest.version} (${result.referencedFiles.length} referenced entrypoint file${result.referencedFiles.length === 1 ? "" : "s"})`,
          ...(hasIncompatible
            ? ["Incompatible contribution versions (parsed but not executable):", ...incompatibleLines]
            : []),
          ...(authorLines.length ? ["Author guidance (registration is not a mounted product feature):", ...authorLines] : []),
        ],
        json: {
          command: "check",
          extensionId: result.project.manifest.id,
          incompatibleContributions: result.incompatibleContributions,
          authorDiagnostics: result.authorDiagnostics,
          missingFiles: result.missingFiles,
          ok: !hasIncompatible,
          referencedFiles: result.referencedFiles,
          version: result.project.manifest.version,
          ...(hasIncompatible ? { warnings: incompatibleLines } : {}),
        },
        quiet: `${hasIncompatible || authorLines.length ? "warn" : "ok"} ${result.project.manifest.id}@${result.project.manifest.version} files:${result.referencedFiles.length}${hasIncompatible ? ` incompatible:${incompatibleLines.length}` : ""}${authorLines.length ? ` guidance:${authorLines.length}` : ""}`,
      });
      return hasIncompatible ? 1 : 0;
    }
    if (parsed.command === "build") {
      const result = await buildProject(parsed.directory);
      const human = result.outputs.length === 0
        ? [`OK: ${result.project.manifest.id} has no executable entrypoints (declarative-only)`]
        : [
          `Built ${result.project.manifest.id}@${result.project.manifest.version}:`,
          ...result.outputs.map((item) => `  ${item.kind} ${item.entrypointId} (${item.mode}) -> ${item.file}`),
        ];
      cliOutput.success({
        human,
        json: {
          command: "build",
          extensionId: result.project.manifest.id,
          outputs: result.outputs,
          version: result.project.manifest.version,
        },
        quiet: `built ${result.project.manifest.id}@${result.project.manifest.version} outputs:${result.outputs.length}`,
      });
      return 0;
    }
    if (parsed.command === "test") {
      const result = await testProject(parsed.directory);
      cliOutput.success({
        human: [
          `PASS: ${result.project.manifest.id}@${result.project.manifest.version}`,
          ...result.surfaces.map((surface) => `  Surface ${surface.entrypointId}: ${surface.result} (${surface.mode})`),
          `  Host: ${result.host}`,
        ],
        json: {
          command: "test",
          extensionId: result.project.manifest.id,
          host: result.host,
          surfaces: result.surfaces,
          version: result.project.manifest.version,
        },
        quiet: `pass ${result.project.manifest.id}@${result.project.manifest.version} surfaces:${result.surfaces.length} host:${result.host}`,
      });
      return 0;
    }
    throw new Error(`Unknown command: ${parsed.command}\n\n${usage}`);
  } catch (error) {
    const inferredMode = parsed ?? {
      json: args.includes("--json"),
      quiet: args.includes("--quiet"),
    };
    new CliOutput({ json: inferredMode.json, quiet: inferredMode.quiet }, output)
      .error(parsed?.command ?? args.find((value) => !value.startsWith("-")), formatContractError(error));
    return 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
