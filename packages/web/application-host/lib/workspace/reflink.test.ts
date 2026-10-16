import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFilePreferReflink } from "./reflink.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

const scratch = async (): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), "varin-reflink-"));
  cleanup.push(dir);
  return dir;
};

describe("copyFilePreferReflink", () => {
  it("copies content on the real filesystem and reports the backend honestly", async () => {
    const dir = await scratch();
    const src = path.join(dir, "a.bin");
    const dst = path.join(dir, "b.bin");
    await fsp.writeFile(src, "reflink-payload\n");
    const backend = await copyFilePreferReflink(src, dst);
    expect(["reflink", "copy"]).toContain(backend);
    expect(await fsp.readFile(dst, "utf8")).toBe("reflink-payload\n");
  });

  it("falls back to a plain copy when the filesystem cannot clone blocks", async () => {
    const dir = await scratch();
    const src = path.join(dir, "a.bin");
    const dst = path.join(dir, "b.bin");
    await fsp.writeFile(src, "x".repeat(64));
    const failing = {
      ...fsp,
      copyFile: vi.fn(async (s: string, d: string, mode?: number) => {
        if (mode === fs.constants.COPYFILE_FICLONE_FORCE) {
          const error = new Error("unsupported") as NodeJS.ErrnoException;
          error.code = "EOPNOTSUPP";
          throw error;
        }
        return fsp.copyFile(s, d, mode);
      }),
    } as unknown as typeof fs.promises;
    expect(await copyFilePreferReflink(src, dst, failing)).toBe("copy");
    expect((await fsp.readFile(dst)).length).toBe(64);
    expect(failing.copyFile).toHaveBeenCalledTimes(2);
  });

  it("does not retry real failures or missing sources", async () => {
    const dir = await scratch();
    const src = path.join(dir, "missing.bin");
    const dst = path.join(dir, "b.bin");
    const copyFile = vi.fn(async () => {
      const error = new Error("no such file") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    await expect(copyFilePreferReflink(src, dst, { ...fsp, copyFile } as unknown as typeof fs.promises))
      .rejects.toThrow("no such file");
    expect(copyFile).toHaveBeenCalledTimes(1);
  });
});

describe("copy permissions", () => {
  it("propagates EACCES instead of falling back to copy", async () => {
    const dir = await scratch();
    const src = path.join(dir, "a.bin");
    const dst = path.join(dir, "b.bin");
    await fsp.writeFile(src, "x".repeat(64));
    const failing = {
      copyFile: vi.fn(async () => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }),
    } as unknown as typeof fs.promises;
    await expect(copyFilePreferReflink(src, dst, failing)).rejects.toThrow("permission denied");
    expect(failing.copyFile).toHaveBeenCalledTimes(1);
  });

  it("propagates EPERM instead of falling back to copy", async () => {
    const dir = await scratch();
    const src = path.join(dir, "a.bin");
    const dst = path.join(dir, "b.bin");
    await fsp.writeFile(src, "x".repeat(64));
    const failing = {
      copyFile: vi.fn(async () => {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }),
    } as unknown as typeof fs.promises;
    await expect(copyFilePreferReflink(src, dst, failing)).rejects.toThrow("operation not permitted");
    expect(failing.copyFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to copy on EXDEV (cross-volume)", async () => {
    const dir = await scratch();
    const src = path.join(dir, "a.bin");
    const dst = path.join(dir, "b.bin");
    await fsp.writeFile(src, "x".repeat(64));
    const failing = {
      ...fsp,
      copyFile: vi.fn(async (s: string, d: string, mode?: number) => {
        if (mode === fs.constants.COPYFILE_FICLONE_FORCE) {
          const error = new Error("cross-device") as NodeJS.ErrnoException;
          error.code = "EXDEV";
          throw error;
        }
        return fsp.copyFile(s, d, mode);
      }),
    } as unknown as typeof fs.promises;
    expect(await copyFilePreferReflink(src, dst, failing)).toBe("copy");
    expect((await fsp.readFile(dst)).length).toBe(64);
    expect(failing.copyFile).toHaveBeenCalledTimes(2);
  });
});
