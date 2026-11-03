import fs from 'node:fs/promises';
import path from 'node:path';

/** Publish code and its identity together; a failed candidate never replaces a valid runtime. */
export async function publishRuntime(candidate, destination, { rename = fs.rename } = {}) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(destination), '.tauri-runtime-publish-'));
  const previous = path.join(temporary, 'previous');
  let moved = false;
  let retain = false;
  try {
    try { await rename(destination, previous); moved = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(candidate, destination); }
    catch (error) {
      if (moved) {
        try { await rename(previous, destination); }
        catch (recovery) {
          retain = true;
          throw new AggregateError([error, recovery], `Could not restore the previous runtime; retained at ${previous}`);
        }
      }
      throw error;
    }
  } finally { if (!retain) await fs.rm(temporary, { recursive: true, force: true }); }
}
