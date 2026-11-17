import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsCommandScript } from "./windows-command.js";

it.skipIf(process.platform !== "win32")(
  "passes real command-script arguments without interpreting shell characters",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "varin-command-"));
    try {
      const script = path.join(directory, "program & script.cmd");
      await writeFile(
        path.join(directory, "args.cjs"),
        "console.log(JSON.stringify(process.argv.slice(2)))",
      );
      await writeFile(
        script,
        `@echo off\r\n"${process.execPath}" "%~dp0args.cjs" %*\r\n`,
      );
      const args = [
        "hello world",
        '" & | < > ^ %VARIN_ESCAPE_FIXTURE%',
        "tail\\",
        'quote"x',
        "",
        "你好",
      ];
      const result = await promisify(execFile)(
        process.env.ComSpec ?? "cmd.exe",
        [windowsCommandScript(script, args)],
        {
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: { ...process.env, VARIN_ESCAPE_FIXTURE: "must-not-expand" },
        },
      );
      expect(JSON.parse(result.stdout.trim())).toEqual(args);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
