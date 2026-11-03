// Run with the pinned Bun build tool, not the installed user's runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
const output=process.argv[2];if(!output)throw new Error('Exporter bundle output is required');
await fs.mkdir(output,{recursive:true});
const result=await Bun.build({entrypoints:[path.resolve(import.meta.dirname,'../../electron/frontend-migration.ts')],outdir:output,
  target:'node',format:'esm',external:['electron','@varin/web','@varin/web/*'],minify:false,sourcemap:'none',naming:'[name].mjs'});
if(!result.success)throw new Error('Controlled legacy exporter could not be bundled');
