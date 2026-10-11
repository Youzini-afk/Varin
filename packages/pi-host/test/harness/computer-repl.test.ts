import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { ComputerRepl } from '../../src/harness/computer-repl.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe('ComputerRepl lifecycle', () => {
  it('drains admitted unawaited callbacks before returning success or script failure', { timeout: 5_000 }, async () => {
    const repl = new ComputerRepl();
    try {
      for (const script of ["void computer.apps(); 'finished'", "void computer.apps(); throw new Error('after dispatch')"]) {
        const entered = deferred<void>();
        const receipt = deferred<unknown>();
        let returned = false;
        const pending = repl.run(script, () => { entered.resolve(); return receipt.promise; }, new AbortController().signal);
        const outcome = pending.then(value => ({ value }), error => ({ error })).finally(() => { returned = true; });
        await entered.promise;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(returned, false);
        receipt.resolve({ apps: [] });
        const result = await outcome;
        if (script.includes('throw')) assert.match(String('error' in result && result.error), /after dispatch/);
        else assert.equal('value' in result && result.value.value, 'finished');
      }
    } finally { await repl.reset(); }
  });

  it('terminates immediately but keeps reset and the next cell waiting for accepted callback settlement', { timeout: 5_000 }, async (t) => {
    const repl = new ComputerRepl();
    const entered = deferred<void>();
    const receipt = deferred<unknown>();
    const exited = deferred<void>();
    const terminate = Worker.prototype.terminate;
    let terminationStarted = false;
    t.mock.method(Worker.prototype, 'terminate', function (this: Worker) {
      terminationStarted = true;
      this.once('exit', () => { exited.resolve(); });
      return terminate.call(this);
    });
    const pending = repl.run('await computer.apps()', () => { entered.resolve(); return receipt.promise; }, new AbortController().signal);
    const failed = assert.rejects(pending, /reset/);
    await entered.promise;
    let resetFinished = false;
    const reset = repl.reset().then(() => { resetFinished = true; });
    let nextDispatched = false;
    const next = repl.run("await computer.apps(); 'new generation'", async () => { nextDispatched = true; }, new AbortController().signal);
    try {
      assert.equal(terminationStarted, true);
      await exited.promise;
      assert.equal(resetFinished, false, 'Worker exit alone cannot discard the accepted callback');
      assert.equal(nextDispatched, false);
      receipt.resolve('late old-worker result');
      await reset;
      await failed;
      assert.equal((await next).value, 'new generation');
      assert.equal(nextDispatched, true);
    } finally { receipt.resolve(undefined); await repl.reset(); }
  });

  it('fences old async continuations while a saved function uses the calling cell', { timeout: 5_000 }, async () => {
    const repl = new ComputerRepl();
    let gate!: Int32Array;
    const calls: unknown[] = [];
    try {
      await repl.run(`
        const gate = new Int32Array(new SharedArrayBuffer(12));
        await computer.apps(gate.buffer);
        void Atomics.waitAsync(gate, 0, 0).value.then(() => computer.apps('old cell'))
          .catch(error => { Atomics.store(gate, 2, error.code === 'SCRIPT_CELL_CLOSED' ? 1 : -1); })
          .finally(() => { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); });
        const saved = () => computer.apps('new cell');
        'ready'
      `, async (_method, args) => { gate = new Int32Array(args[0] as SharedArrayBuffer); }, new AbortController().signal);
      const next = await repl.run(`
        await computer.apps('release old continuation');
        if (Atomics.load(gate, 1) === 0) await Atomics.waitAsync(gate, 1, 0).value;
        await saved();
        typeof tools
      `, async (_method, args) => {
        calls.push(args[0]);
        if (args[0] === 'release old continuation') { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); }
      }, new AbortController().signal);
      assert.deepEqual(calls, ['release old continuation', 'new cell']);
      assert.equal(Atomics.load(gate, 2), 1);
      assert.equal(next.value, 'undefined', 'Pi installation must not gain Native tools.invoke');
    } finally { await repl.reset(); }
  });
});
