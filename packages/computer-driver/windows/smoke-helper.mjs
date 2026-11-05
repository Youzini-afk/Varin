#!/usr/bin/env node
/** Installed-path transport smoke; deliberately never observes or injects desktop input. */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import artifact from './helper-artifact.cjs';

export async function smokeWindowsComputerHelper(directory) {
  if (process.platform !== 'win32') throw new Error('Native Windows helper smoke requires Windows');
  const manifest = artifact.verifyHelper(directory, { architecture: process.arch });
  for (const role of ['input', 'capture']) {
    const pipe = `\\\\.\\pipe\\varin-computer-smoke-${randomUUID()}`;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PATH', 'VARIN_DRIVER_CANCEL_DIR', 'VARIN_DRIVER_CONTROL_PIPE'].includes(key.toUpperCase())));
    const child = spawn(path.join(directory, artifact.EXECUTABLE), [], { cwd: directory, windowsHide: true,
      env: { ...environment, PATH: process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '', VARIN_DRIVER_ROLE: role,
        ...(role === 'input' ? { VARIN_DRIVER_CONTROL_PIPE: pipe } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let control;
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Computer helper smoke exited with code ${code}`))); });
    // Observe all rejection paths immediately, including failure before first stdout.
    void closed.catch(() => {});
    const deadline = setTimeout(() => child.kill(), 15_000);
    const pending = new Map(); let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n'); if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { const result = JSON.parse(line); pending.get(result.id)?.(result); pending.delete(result.id); }
        catch { child.kill(); }
      }
    });
    const request = tool => Promise.race([new Promise(resolve => {
      const id = randomUUID(); pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, tool }) + '\n');
    }), closed.then(() => { throw new Error('Computer helper closed before its handshake response'); })]);
    try {
      for (const tool of ['ping', 'capabilities']) {
        const response = await request(tool);
        if (!response.ok || response.protocolVersion !== artifact.PROTOCOL_VERSION || response.build?.version !== manifest.version
          || response.build?.architecture !== manifest.architecture || response.build?.buildId !== manifest.buildId) throw new Error(`Computer helper ${role}/${tool} identity mismatch`);
      }
      if (role === 'input') {
        control = createConnection(pipe); control.setEncoding('utf8');
        await Promise.race([new Promise((resolve, reject) => { control.once('connect', resolve); control.once('error', reject); }), closed]);
        const id = randomUUID();
        const acknowledgement = new Promise((resolve, reject) => {
          let received = '';
          control.on('data', chunk => { received += chunk; if (received.includes('\n')) { try { resolve(JSON.parse(received.split('\n')[0])); } catch (error) { reject(error); } } });
          control.once('error', reject);
        });
        control.write(JSON.stringify({ id, command: 'interrupt', restoreFocus: false }) + '\n');
        const response = await Promise.race([acknowledgement, closed.then(() => { throw new Error('Computer helper exited before release acknowledgement'); })]);
        if (response.id !== id || response.ok !== true || response.released !== true) throw new Error('Computer helper did not acknowledge its empty input release');
      }
      child.stdin.end();
      await closed;
    } finally { clearTimeout(deadline); control?.destroy(); if (child.exitCode === null) child.kill(); }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await smokeWindowsComputerHelper(path.resolve(process.argv[2] || path.join(import.meta.dirname, 'build')));
  console.log('Windows native Computer helper handshake, control and EOF smoke passed');
}
