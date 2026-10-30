import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const hash = () => createHash('sha256');
const portable = name => name.replaceAll('\\', '/');

/** Disposable build metadata. Inputs and published output bytes, rather than timestamps, own reuse. */
export class BuildCache {
  constructor(root, directory = path.join(root, 'artifacts/build/cache')) {
    this.root = root; this.directory = directory; this.pending = new Map();
  }
  async inputs(paths) {
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths], {
      cwd: this.root, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    }).toString().split('\0').filter(Boolean).filter(name => !/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/u.test(name));
    const digest = hash();
    for (const name of [...new Set(files)].sort()) {
      digest.update(name).update('\0');
      try { digest.update(await fs.readFile(path.join(this.root, name))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; digest.update('<missing>'); }
      digest.update('\0');
    }
    return digest.digest('hex');
  }
  async outputs(paths) {
    const digest = hash();
    const visit = async (filename, relative) => {
      const stat = await fs.lstat(filename);
      digest.update(portable(relative)).update('\0');
      if (stat.isDirectory()) {
        for (const name of (await fs.readdir(filename)).sort()) await visit(path.join(filename, name), path.join(relative, name));
      } else if (stat.isSymbolicLink()) digest.update(await fs.readlink(filename));
      else digest.update(await fs.readFile(filename));
      digest.update('\0');
    };
    for (const filename of paths) await visit(filename, path.relative(this.root, filename));
    return digest.digest('hex');
  }
  task(name, spec) {
    if (!this.pending.has(name)) this.pending.set(name, this.execute(name, spec));
    return this.pending.get(name);
  }
  async execute(name, { inputs, values = {}, outputs, build }) {
    const start = performance.now();
    const source = await this.inputs(inputs);
    const key = hash().update(JSON.stringify({ source, values })).digest('hex');
    const receiptPath = path.join(this.directory, `${name}.json`);
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (receipt?.key === key) {
      try {
        if (await this.outputs(outputs) === receipt.digest) {
          console.log(`[build] ${name}: reused (${((performance.now() - start) / 1000).toFixed(1)}s)`);
          return receipt;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.mkdir(this.directory, { recursive: true });
    await fs.rm(receiptPath, { force: true });
    console.log(`[build] ${name}: building`);
    await build();
    receipt = { schema: 1, source, values, key, digest: await this.outputs(outputs) };
    await fs.writeFile(receiptPath, JSON.stringify(receipt) + '\n');
    console.log(`[build] ${name}: ready (${((performance.now() - start) / 1000).toFixed(1)}s)`);
    return receipt;
  }
  async export(name, directory, output) {
    const receipt = JSON.parse(await fs.readFile(path.join(this.directory, `${name}.json`), 'utf8'));
    const payload = path.join(directory, 'payload');
    await fs.rm(payload, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true });
    await fs.cp(output, payload, { recursive: true });
    await fs.writeFile(path.join(directory, 'build-artifact.json'), JSON.stringify({ ...receipt,
      content: await new BuildCache(directory).outputs([payload]),
    }) + '\n');
  }
  async restore(name, directory, { inputs, values, output }) {
    const receipt = JSON.parse(await fs.readFile(path.join(directory, 'build-artifact.json'), 'utf8'));
    if (receipt.schema !== 1 || receipt.source !== await this.inputs(inputs)
      || JSON.stringify(receipt.values) !== JSON.stringify(values)) throw new Error(`${name}: artifact source or build options mismatch`);
    const payload = path.join(directory, 'payload');
    if (await new BuildCache(directory).outputs([payload]) !== receipt.content) throw new Error(`${name}: artifact content mismatch`);
    await fs.rm(output, { recursive: true, force: true });
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.cp(payload, output, { recursive: true });
    const restored = { ...receipt, digest: await this.outputs([output]) };
    delete restored.content;
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(path.join(this.directory, `${name}.json`), JSON.stringify(restored) + '\n');
    console.log(`[build] ${name}: restored verified artifact`);
    return restored;
  }
}
