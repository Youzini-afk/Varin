try {
  if (process.argv.includes('--varin-export-frontend-state') || process.argv.includes('--varin-export-private-state')) await import('./dist-bundle/frontend-migration.mjs');
  else await import('./dist-bundle/main.mjs');
} catch (error) {
  // Static imports run before main.ts can initialize electron-log. Report those
  // failures through stderr so packaged startup smoke has a useful cause.
  process.stderr.write(`[electron] failed to import main module: ${error?.stack ?? error}\n`);
  process.exit(1);
}
