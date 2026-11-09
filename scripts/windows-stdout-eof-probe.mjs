import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const file = path.join(root, 'packages/web/application-host/lib/kernel/kernel-process.native.test.ts');
const source = await fs.readFile(file, 'utf8');
const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
let target;
function find(node) {
  if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
    && node.arguments[0].text === 'Host observes stdout EOF before process exit without ending still-live stderr') target = node;
  ts.forEachChild(node, find);
}
find(tree);
if (!target) throw new Error('EOF test not found');
const initializers = {};
function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ['command', 'args'].includes(node.name.text)) {
    initializers[node.name.text] = node.initializer.getText(tree);
  }
  ts.forEachChild(node, collect);
}
collect(target);
const fixture = platform => Object.fromEntries(Object.entries(initializers).map(([key, text]) => [key,
  runInNewContext(text, {process: {platform, execPath: process.execPath}})]));

async function probe(label, {command, args}) {
  const started = Date.now();
  const log = (event, data = {}) => console.log(JSON.stringify({label, ms: Date.now() - started, event, ...data}));
  let output = '', errorOutput = '', closed = false;
  const child = spawn(command, args, {stdio: 'pipe', windowsHide: true, env: process.env});
  log('spawn', {pid: child.pid, command});
  child.on('error', error => log('error', {message: error.message}));
  child.stdin.on('error', error => log('stdin-error', {message: error.message}));
  child.stdout.on('data', bytes => { output += bytes.toString(); log('stdout-data', {hex: bytes.toString('hex')}); });
  child.stderr.on('data', bytes => { errorOutput += bytes.toString(); log('stderr-data', {hex: bytes.toString('hex')}); });
  child.stdout.on('end', () => log('stdout-end'));
  child.stderr.on('end', () => log('stderr-end'));
  child.on('exit', (code, signal) => log('exit', {code, signal}));
  const done = new Promise(resolve => child.on('close', (code, signal) => { closed = true; log('close', {code, signal}); resolve(); }));
  const snapshot = () => ({output, errorOutput, stdoutEnded: child.stdout.readableEnded, stderrEnded: child.stderr.readableEnded,
    stdoutDestroyed: child.stdout.destroyed, stderrDestroyed: child.stderr.destroyed, exitCode: child.exitCode, signalCode: child.signalCode});
  await new Promise(resolve => setTimeout(resolve, 3000));
  log('before-handshake', snapshot());
  if (!closed) child.stdin.write('finish', error => log('handshake-write', {error: error?.message}));
  await Promise.race([done, new Promise(resolve => setTimeout(resolve, 3000))]);
  log('after-handshake', snapshot());
  if (!closed) {
    log('cleanup', snapshot());
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (!closed) {
      log('inherited-pipes-still-open', snapshot());
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    }
  }
}
console.log(JSON.stringify({platform: process.platform, node: process.version}));
await probe('node-close-fd-1', fixture('linux'));
if (process.platform !== 'win32') process.exit(0);
await probe('powershell-close-std-handle', fixture('win32'));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-eof-raw-'));
try {
  const code = `using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class RawPipeEof {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr h, byte[] b, uint n, out uint written, IntPtr overlap);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, byte[] b, uint n, out uint read, IntPtr overlap);
  static void Write(int id, string text) {
    byte[] bytes=Encoding.ASCII.GetBytes(text); uint n;
    if (!WriteFile(GetStdHandle(id),bytes,(uint)bytes.Length,out n,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (n != bytes.Length) throw new Exception("Short write");
  }
  public static int Main() {
    try {
      Write(-11,"stdout");
      if (!CloseHandle(GetStdHandle(-11))) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint n; byte[] b=new byte[1];
      if (!ReadFile(GetStdHandle(-10),b,1,out n,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (n != 1) throw new Exception("Missing stdin handshake");
      Write(-12,"after stdout EOF"); return 0;
    } catch(Exception error) { Console.Error.Write(error.ToString()); return 1; }
  }
}`;
  const sourcePath = path.join(directory, 'RawPipeEof.cs'), executable = path.join(directory, 'RawPipeEof.exe');
  await fs.writeFile(sourcePath, code);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await new Promise((resolve, reject) => {
    const compiler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; try { Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(sourcePath)})) -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication; exit 0 } catch { [Console]::Error.Write($_.Exception.ToString()); exit 1 }`], {stdio: ['ignore','pipe','pipe'], windowsHide:true});
    let diagnostics=''; compiler.stdout.on('data', b => { diagnostics += b; }); compiler.stderr.on('data', b => { diagnostics += b; });
    compiler.once('error',reject); compiler.once('close',code => code===0 ? resolve() : reject(new Error('Fixture compilation failed: '+diagnostics)));
  });
  await probe('standalone-raw-win32-exe', {command:executable, args:[]});
} finally { await fs.rm(directory,{recursive:true,force:true}); }
