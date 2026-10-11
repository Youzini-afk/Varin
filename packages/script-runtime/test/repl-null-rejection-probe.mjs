// Manual, finite upstream-semantics probe, deliberately not a passing behavior
// test. Run with the same Node binary/flags as the evaluator. No package code is
// involved: Node REPL's public callback aliases these two different outcomes.
import { start } from "node:repl";
import { PassThrough, Writable } from "node:stream";

for (const script of ["await Promise.resolve(undefined)", "await Promise.reject(null)"]) {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const server = start({ input, output, terminal: false, useGlobal: false });
  const observed = await new Promise((resolve) => {
    server.eval(`${script}\n`, server.context, "upstream-probe", (error, value) => {
      resolve({ errorType: typeof error, errorText: String(error), valueType: typeof value, valueText: String(value) });
    });
  });
  console.log(JSON.stringify({ node: process.version, script, observed }));
  server.close();
  input.destroy();
  output.destroy();
}

// In Node 24.19.0's bundled lib/repl.js, defaultEval awaits Node's own transformed
// Promise. Success calls finishExecution(null, result). Its catch calls
// finishExecution(err) when err is falsy; finishExecution unconditionally invokes
// cb(err, result). Thus null rejection and success(undefined) both call
// cb(null, undefined). The public custom-eval hook replaces the evaluator; it
// does not expose this original rejection before the callback. This package
// deliberately does not fork/patch that parser or rewrite the user's program.
