import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriverSession, computerDriverDir, localDriverSpawnSpec } from "./driver-host.js";

/**
 * Driver supervisor tests run against a real child process speaking the
 * line-delimited protocol — the same contract the native/Python drivers
 * implement — so queueing, correlation, and exit handling are exercised for
 * real, not against a mock of the module under test.
 */

// Echoes each request with ok + the tool name; supports a "hang" op that never
// replies and an "exit" op that terminates the process.
const ECHO_DRIVER = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.tool === "hang") continue;
    if (message.tool === "awaitflag") {
      // Polls its own cancel flag file — proves cancel() writes where the
      // driver actually looks, at the same path shape real drivers poll.
      const fs = require("fs");
      const path = require("path");
      const flag = path.join(process.env.VARIN_DRIVER_CANCEL_DIR || "", message.id + ".cancel");
      const poll = setInterval(() => {
        if (fs.existsSync(flag)) {
          clearInterval(poll);
          process.stdout.write(JSON.stringify({ id: message.id, ok: false, cancelled: true, error: "cancelled" }) + "\\n");
        }
      }, 5);
      continue;
    }
    if (message.tool === "exit") process.exit(3);
    if (message.tool === "slow") { setTimeout(() => process.stdout.write(JSON.stringify({id:message.id,ok:true}) + "\\n"), 120); continue; }
    process.stdout.write(JSON.stringify({ id: message.id, ok: message.tool !== "fail", text: "did:" + message.tool, error: message.tool === "fail" ? "op failed" : undefined }) + "\\n");
  }
});
`;

const echoSpec = () => ({
  command: process.execPath,
  args: ["-e", ECHO_DRIVER],
});

describe("computer driver host (BC4)", () => {
  it('rejects revoked input at transport dispatch even when it waited behind another native request', async () => {
    const driver = createDriverSession(echoSpec());
    try {
      const first = driver.request({ tool: 'ping' });
      let revoked = false;
      const queued = driver.request({ tool: 'click' }, { beforeDispatch: () => { if (revoked) throw new Error('Assignment revoked'); } });
      const rejected = expect(queued).rejects.toThrow('Assignment revoked');
      revoked = true; await first; await rejected;
      expect((await driver.request({ tool: 'ping' })).ok).toBe(true);
    } finally { await driver.dispose(); }
  });
  it('delivers native progress without resolving early or forwarding input text', async () => {
    const driver = createDriverSession({ command: process.execPath, args: ['-e', `
      const rl=require('readline').createInterface({input:process.stdin});
      rl.on('line',line=>{const op=JSON.parse(line);console.log(JSON.stringify({id:op.id,type:'gesture',phase:'target',point:{x:42,y:73},text:'private input'}));
        console.log(JSON.stringify({id:op.id,type:'gesture',phase:'dispatched'}));console.log(JSON.stringify({id:op.id,ok:true}));});`] });
    const progress: unknown[] = [];
    try {
      expect((await driver.request({ tool: 'click', visual_feedback: true }, { onGesture: event => progress.push(event) })).ok).toBe(true);
      expect(progress).toEqual([{ phase: 'target', point: { x: 42, y: 73 } }, { phase: 'dispatched' }]);
    } finally { await driver.dispose(); }
  });
  it("correlates concurrent requests and serializes them on the wire", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      const [a, b, c] = await Promise.all([
        driver.request({ tool: "click" }),
        driver.request({ tool: "scroll" }),
        driver.request({ tool: "press_key" }),
      ]);
      expect(a.text).toBe("did:click");
      expect(b.text).toBe("did:scroll");
      expect(c.text).toBe("did:press_key");
      expect(driver.alive()).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("a driver-side error resolves the op without poisoning later requests", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      const failed = await driver.request({ tool: "fail" });
      expect(failed.ok).toBe(false);
      expect(failed.error).toBe("op failed");
      const after = await driver.request({ tool: "ping" });
      expect(after.ok).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("capture may respawn after an unexpected exit", async () => {
    const driver = createDriverSession({ ...echoSpec(), env: { ...process.env, VARIN_DRIVER_ROLE: 'capture' } });
    try {
      const exitResult = await driver.request({ tool: "exit" }).catch((error: unknown) => error);
      expect(exitResult).toBeInstanceOf(Error);
      expect((exitResult as Error).message).toMatch(/exit/i);
      // The supervisor respawns on demand rather than staying dead.
      const recovered = await driver.request({ tool: "ping" });
      expect(recovered.ok).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("a wedged input helper ends its session instead of forging a replacement release identity", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      await expect(driver.request({ tool: "hang" }, { timeoutMs: 300 }))
        .rejects.toThrow(/timed out/);
      await expect(driver.request({ tool: "ping" })).rejects.toThrow(/original Computer input helper exited/);
    } finally {
      await driver.dispose();
    }
  });

  it('an exited input helper cannot respawn inside its old pool identity', async () => {
    const { createDesktopDriverPool } = await import('./desktop-drivers.js');
    const pool = createDesktopDriverPool({ resolve: async id => ({ spec: echoSpec(), desktop: { id } as never }), onInputReset: () => {} });
    try {
      const first = (await pool.acquire('desktop')).driver;
      const firstId = pool.inputOwnerId(first);
      await expect(first.request({ tool: 'exit' })).rejects.toThrow(/exited/);
      await expect(first.request({ tool: 'release_input' })).rejects.toThrow(/original Computer input helper exited/);
      const next = (await pool.acquire('desktop')).driver;
      expect(next).not.toBe(first); expect(pool.inputOwnerId(next)).not.toBe(firstId);
      expect((await next.request({ tool: 'ping' })).ok).toBe(true);
    } finally { await pool.dispose(); }
  });

  it("cancel() writes the in-flight request's flag file on the side-channel", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      expect(driver.cancel()).toBe(false);
      const inFlight = driver.request({ tool: "awaitflag" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(driver.cancel()).toBe(true);
      const response = await inFlight;
      expect(response.ok).toBe(false);
      expect(response.cancelled).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("dispose fails pending work and refuses new requests", async () => {
    const driver = createDriverSession(echoSpec());
    const wedged = driver.request({ tool: "hang" });
    const queued = driver.request({ tool: "click" });
    const rejected = Promise.allSettled([wedged, queued]);
    driver.dispose();
    expect((await rejected).every((result) => result.status === "rejected")).toBe(true);
    await expect(driver.request({ tool: "ping" })).rejects.toThrow(/disposed/);
    expect(driver.alive()).toBe(false);
  });

  it("starts each request budget at dispatch rather than timing out queued input that later executes", async () => {
    const driver = createDriverSession(echoSpec());
    try {
      await driver.request({ tool: "ping" });
      const [slow, next] = await Promise.all([
        driver.request({ tool: "slow" }), driver.request({ tool: "click" }, { timeoutMs: 60 }),
      ]);
      expect(slow.ok).toBe(true);
      expect(next.text).toBe("did:click");
    } finally { driver.dispose(); }
  });

  it("ignores malformed lines on stdout without breaking correlation", async () => {
    const noisySpec = {
      command: process.execPath,
      args: ["-e", `
        process.stdout.write("not json at all\\n");
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const newline = buffer.indexOf("\\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const message = JSON.parse(line);
            process.stdout.write("garbage\\n" + JSON.stringify({ id: message.id, ok: true }) + "\\n");
          }
        });
      `],
    };
    const driver = createDriverSession(noisySpec);
    try {
      const response = await driver.request({ tool: "ping" });
      expect(response.ok).toBe(true);
    } finally {
      driver.dispose();
    }
  });
});

describe("computerDriverDir (BC9 packaging)", () => {
  it('uses physical unpacked driver files when the supplied path is inside an ASAR archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'varin-computer-assets-'));
    const logical = join(root, 'app.asar', 'server', 'computer-driver');
    const physical = join(root, 'app.asar.unpacked', 'server', 'computer-driver');
    mkdirSync(join(physical, 'windows'), { recursive: true });
    writeFileSync(join(physical, 'windows', 'VarinComputer.exe'), 'native fixture');
    writeFileSync(join(physical, 'windows', 'manifest.json'), JSON.stringify({ schema: 1, protocolVersion: 1, executable: 'VarinComputer.exe', version: '1.2.3', architecture: process.arch, buildId: 'test' }));
    try {
      const spec = localDriverSpawnSpec('windows', logical);
      expect(spec?.command).toBe(join(physical, 'windows', 'VarinComputer.exe'));
      expect(spec?.args).toEqual([]);
      expect(spec?.nativeWindows?.version).toBe('1.2.3');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("env override wins and the fallback resolves real driver assets", () => {
    const original = process.env.VARIN_COMPUTER_DRIVER_DIR;
    try {
      process.env.VARIN_COMPUTER_DRIVER_DIR = "/override/dir";
      expect(computerDriverDir()).toBe("/override/dir");
      delete process.env.VARIN_COMPUTER_DRIVER_DIR;
      const resolved = computerDriverDir();
      // Source checkout or staged package copy owns the driver directory.
      expect(existsSync(resolved)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.VARIN_COMPUTER_DRIVER_DIR;
      else process.env.VARIN_COMPUTER_DRIVER_DIR = original;
    }
  });
});

describe('shared native desktop session', () => {
  it('captures and coalesces viewers while ordered input waits for its real cancel receipt', async () => {
    const driver = createDriverSession({ ...echoSpec(), sharedDesktopSession: true });
    try {
      const input = driver.request({ tool: 'awaitflag' });
      const frames = [driver.capture!(), driver.capture!()];
      expect(frames[0]).toBe(frames[1]);
      expect((await frames[0]!).text).toBe('did:capture_frame');
      let drained = false;
      void input.then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(driver.cancel()).toBe(true);
      expect((await input).cancelled).toBe(true);
      expect((await driver.request({ tool: 'release_input' })).ok).toBe(true);
      expect((await driver.capture!()).ok).toBe(true);
    } finally { await driver.dispose(); }
  });

  it('uses one platform owner for controller and observers and keeps capture alive after job drain', async () => {
    const { createDesktopDriverPool } = await import('./desktop-drivers.js');
    let starts = 0;
    const pool = createDesktopDriverPool({
      resolve: async id => ({ spec: { ...echoSpec(), sharedDesktopSession: true }, desktop: { id } as never }),
      createDriver: spec => { starts += 1; return createDriverSession(spec); }, onInputReset: () => {},
    });
    try {
      const [input, observer, otherObserver] = await Promise.all([pool.acquire('desktop'), pool.acquire('desktop', 'capture'), pool.acquire('desktop', 'capture')]);
      expect(starts).toBe(1);
      expect(pool.inputOwnerId(input.driver)).toBeTruthy();
      await expect(observer.driver.request({ tool: 'click' })).rejects.toThrow('read-only');
      const work = input.driver.request({ tool: 'awaitflag' });
      expect((await otherObserver.driver.request({ tool: 'capture_frame' })).ok).toBe(true);
      input.driver.cancel();
      await work;
      await input.driver.request({ tool: 'release_input' });
      await observer.driver.dispose();
      expect((await otherObserver.driver.request({ tool: 'capture_frame' })).ok).toBe(true);
      expect(starts).toBe(1);
      await pool.reset('desktop');
      expect(otherObserver.driver.alive()).toBe(false);
    } finally { await pool.dispose(); }
  });

  it('drains a capture startup that was already admitted when a desktop reset began', async () => {
    const { createDesktopDriverPool } = await import('./desktop-drivers.js');
    let allowResolve!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { allowResolve = resolve; });
    let resolves = 0;
    const pool = createDesktopDriverPool({ resolve: async id => {
      if (resolves++ === 0) { entered(); await gate; }
      return { spec: { ...echoSpec(), sharedDesktopSession: true }, desktop: { id } as never };
    }, onInputReset: () => {} });
    try {
      const capture = pool.acquire('desktop', 'capture');
      await started;
      const reset = pool.reset('desktop');
      allowResolve();
      const observer = (await capture).driver;
      await reset;
      expect(observer.alive()).toBe(false);
      expect((await pool.acquire('desktop')).driver.alive()).toBe(true);
    } finally { await pool.dispose(); }
  });

  it('launches the packaged native macOS bundle without an interpreter fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'varin-macos-helper-'));
    const executable = join(root, 'macos', 'Varin Computer.app', 'Contents', 'MacOS', 'VarinComputer');
    try {
      expect(localDriverSpawnSpec('macos', root)).toBeNull();
      mkdirSync(join(executable, '..'), { recursive: true });
      writeFileSync(executable, 'native helper fixture');
      const spec = localDriverSpawnSpec('macos', root);
      expect(spec?.command).toBe(executable);
      expect(spec?.args).toEqual([]);
      expect(spec?.sharedDesktopSession).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

const NATIVE_DRIVER = `
const net = require('net');
const fs = require('fs');
const input = require('readline').createInterface({input: process.stdin});
input.pause();
const held = new Map();
const reply = value => console.log(JSON.stringify(value));
let fenced = false;
const server = process.env.VARIN_DRIVER_ROLE === 'capture' ? null : net.createServer(socket => {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\\n')) {
      const at = buffer.indexOf('\\n'); const op = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at+1);
      if (op.command === 'interrupt') { fenced = true; if (process.env.CONTROL_LOG) fs.appendFileSync(process.env.CONTROL_LOG, 'interrupt\\n'); }
      socket.write(JSON.stringify({id:op.id,ok:true,released:process.env.FAIL_RELEASE !== '1'})+'\\n');
      for (const [id, request] of held) if (op.command === 'interrupt' || op.requestId === id) {
        if (request.tool !== 'wedged') { held.delete(id); reply({id,ok:false,cancelled:true,receipt:{effect:'partial'}}); }
      }
    }
  });
});
function start() {
  input.on('line', line => {
    const op = JSON.parse(line);
    if (op.tool === 'ping' || op.tool === 'capabilities') {
      reply({id:op.id,ok:true,protocolVersion:Number(process.env.PROTOCOL || 1),build:{version:'1.2.3',architecture:process.arch,buildId:'test'},text:process.env.VARIN_DRIVER_ROLE}); return;
    }
    if (op.tool === 'exit') process.exit(9);
    if (op.tool === 'awaitcancel' || op.tool === 'wedged') { held.set(op.id, op); return; }
    if (op.tool === 'click' && process.env.DISPATCH_LOG) fs.appendFileSync(process.env.DISPATCH_LOG,'click\\n');
    reply({id:op.id,ok:!fenced,text:'did:'+op.tool});
  });
  input.resume();
}
if (server) server.listen(process.env.VARIN_DRIVER_CONTROL_PIPE,start); else start();
input.on('close',()=>process.exit(0));
`;

function nativeFixture(environment: NodeJS.ProcessEnv = {}, role = 'input') {
  const directory = mkdtempSync(join(tmpdir(), 'varin-native-wire-'));
  const spec = { command: process.execPath, args: ['-e', NATIVE_DRIVER],
    nativeWindows: { version: '1.2.3', architecture: process.arch as 'x64' | 'arm64', buildId: 'test' },
    controlPipe: process.platform === 'win32' ? `\\\\.\\pipe\\varin-test-${directory.split(/[\\/]/).at(-1)}` : join(directory, 'control.sock'),
    env: { ...process.env, VARIN_DRIVER_ROLE: role, ...environment } as NodeJS.ProcessEnv };
  const driver = createDriverSession(spec);
  return { driver, spec, directory, async dispose() { await driver.dispose(); rmSync(directory, { recursive: true, force: true }); } };
}

describe('Windows native helper contract', () => {
  it('rejects an incompatible handshake before delivering any desktop action', async () => {
    const fixture = nativeFixture({ PROTOCOL: '99' }, 'capture');
    try {
      await expect(fixture.driver.request({ tool: 'click' })).rejects.toThrow('protocol or build identity');
      expect(fixture.driver.alive()).toBe(false);
    } finally { await fixture.dispose(); }
  });

  it.skipIf(process.platform !== 'win32')('cancels through the existing control connection and reuses the healthy original helper', async () => {
    const fixture = nativeFixture();
    try {
      expect((await fixture.driver.request({ tool: 'ping' })).text).toBe('input');
      for (let i = 0; i < 2; i++) {
        const action = fixture.driver.request({ tool: 'awaitcancel' });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(fixture.driver.cancel()).toBe(true);
        expect((await action).cancelled).toBe(true);
        expect((await fixture.driver.request({ tool: 'click' })).ok).toBe(true);
      }
      expect(await fixture.driver.interrupt!({ restoreFocus: false })).toEqual({ released: true });
      expect(fixture.driver.alive()).toBe(false);
    } finally { await fixture.dispose(); }
  });

  it.skipIf(process.platform !== 'win32')('confirms independent release and actual exit even when the original request never answers', async () => {
    const fixture = nativeFixture();
    try {
      await fixture.driver.request({ tool: 'ping' });
      const action = fixture.driver.request({ tool: 'wedged' });
      const queued = fixture.driver.request({ tool: 'click' });
      const outcomes = Promise.allSettled([action, queued]);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(await fixture.driver.interrupt!()).toEqual({ released: true });
      expect((await outcomes).every(result => result.status === 'rejected')).toBe(true);
      await expect(fixture.driver.request({ tool: 'click' })).rejects.toThrow(/disposed|interrupted/);
      expect(fixture.driver.alive()).toBe(false);
    } finally { await fixture.dispose(); }
  });

  it.skipIf(process.platform !== 'win32')('never converts failed release or a lost original helper into a release acknowledgement', async () => {
    const failed = nativeFixture({ FAIL_RELEASE: '1' });
    const crashed = nativeFixture();
    try {
      await failed.driver.request({ tool: 'ping' });
      expect(await failed.driver.interrupt!()).toEqual({ released: false });
      // Process close and pipe close can arrive in either order. Both lose the
      // original effect receipt; neither can acknowledge release or replay it.
      await expect(crashed.driver.request({ tool: 'exit' })).rejects.toThrow(
        /Computer driver exited \(code 9\)|Computer input control channel closed; original input outcome is unknown/,
      );
      expect(crashed.driver.alive()).toBe(false);
      await expect(crashed.driver.request({ tool: 'click' })).rejects.toThrow('original Computer input helper exited');
      expect(await crashed.driver.interrupt!()).toEqual({ released: false });
    } finally { await failed.dispose(); await crashed.dispose(); }
  });

  it.skipIf(process.platform !== 'win32')('releases the original native owner before direct disposal without claiming a higher-level receipt', async () => {
    const fixture = nativeFixture();
    const log = join(fixture.directory, 'control.log');
    fixture.spec.env.CONTROL_LOG = log;
    try {
      await fixture.driver.request({ tool: 'ping' });
      await fixture.driver.dispose();
      expect(readFileSync(log, 'utf8')).toBe('interrupt\n');
      expect(fixture.driver.alive()).toBe(false);
    } finally { await fixture.dispose(); }
  });

  it('starts the read-only capture role without an input channel and validates a replacement handshake', async () => {
    const fixture = nativeFixture({}, 'capture');
    try {
      expect(fixture.driver.interrupt).toBeUndefined();
      expect((await fixture.driver.request({ tool: 'ping' })).text).toBe('capture');
      await expect(fixture.driver.request({ tool: 'exit' })).rejects.toThrow('exited');
      expect((await fixture.driver.request({ tool: 'capture_frame' })).ok).toBe(true);
    } finally { await fixture.dispose(); }
  });

  it('does not start PowerShell or compile when the native artifact is missing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'varin-native-missing-'));
    try {
      mkdirSync(join(directory, 'windows'));
      writeFileSync(join(directory, 'windows', 'driver-host.ps1'), 'retired fixture');
      expect(localDriverSpawnSpec('windows', directory)).toBeNull();
      writeFileSync(join(directory, 'windows', 'VarinComputer.exe'), 'fixture');
      expect(() => localDriverSpawnSpec('windows', directory)).toThrow('manifest');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('request-scoped read cancellation', () => {
  it('removes an aborted queued read without cancelling the current native request', async () => {
    const driver = createDriverSession(echoSpec());
    const controller = new AbortController();
    try {
      const input = driver.request({ tool: 'slow' });
      const read = driver.request({ tool: 'query_elements' }, { signal: controller.signal });
      const cancelled = expect(read).rejects.toThrow('read cancelled');
      controller.abort(new Error('read cancelled'));
      await cancelled;
      expect((await input).ok).toBe(true);
      expect((await driver.request({ tool: 'click' })).ok).toBe(true);
    } finally { await driver.dispose(); }
  });

  it('signals only the original active read and leaves the next input queued until it returns', async () => {
    const driver = createDriverSession(echoSpec());
    const controller = new AbortController();
    try {
      const read = driver.request({ tool: 'awaitflag' }, { signal: controller.signal });
      const input = driver.request({ tool: 'click' });
      controller.abort();
      expect(await read).toMatchObject({ ok: false, cancelled: true });
      expect(await input).toMatchObject({ ok: true, text: 'did:click' });
      expect(driver.alive()).toBe(true);
    } finally { await driver.dispose(); }
  });
});
