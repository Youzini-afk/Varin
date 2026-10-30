import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDist = path.resolve(mobileRoot, '../web/dist');
const mobileDist = path.resolve(mobileRoot, 'dist');
const mobileHtml = path.join(mobileDist, 'mobile.html');
const indexHtml = path.join(mobileDist, 'index.html');
// The desktop companion is a native transparent window that only the desktop shell opens.
// Its entry page and artwork (about 95 MiB of atlases) are not shipped inside mobile apps.
const desktopOnly = new Set(['companion.html', 'companion-assets', 'companion-review-director']);

await rm(mobileDist, { recursive: true, force: true });
await mkdir(mobileDist, { recursive: true });
await cp(webDist, mobileDist, {
  recursive: true,
  filter: source => {
    const relative = path.relative(webDist, source);
    return !desktopOnly.has(relative.split(path.sep)[0]);
  },
});

const html = await readFile(mobileHtml, 'utf8');
await writeFile(indexHtml, html);
