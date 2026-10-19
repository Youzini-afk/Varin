#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeDesktopApp } from './smoke-desktop-unpacked.mjs';

if (process.platform !== 'win32') throw new Error('The unpacked Windows smoke test must run on Windows.');
const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await smokeDesktopApp(
  process.argv[2] ?? path.join(electronDir, 'dist', 'win-unpacked', 'Varin.exe'),
  process.argv.slice(3),
);
