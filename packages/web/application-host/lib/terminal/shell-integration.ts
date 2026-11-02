/**
 * Parse FinalTerm/VS Code OSC 133/633 command lifecycle sequences.
 * Command text and exit codes come only from those sequences — never from
 * prompt painting or raw PTY text.
 *
 * Varin only accepts frames tagged with this session integration id
 * (`pi;<terminalId>:<generation>;<body>`). Other OSC 133/633 or ordinary
 * program output is ignored. The tag is source-bound observation, not an
 * unforgeable security identity.
 */

export type ShellIntegrationSequence =
  | { kind: "prompt-start" }
  | { kind: "command-start" }
  | { kind: "command-executed" }
  | { kind: "command-finished"; exitCode: number }
  | { kind: "command-line"; command: string }
  | { kind: "cwd"; cwd: string };

export type TerminalCommandObservation = {
  command: string;
  commandId: string;
  cwd?: string;
  endedAt: number;
  exitCode: number;
  integration: "osc-633";
  startedAt?: number;
  terminalId: string;
};

export type ShellIntegrationStatus = "not-observed" | "ready";

// Match the terminal's retained-history allocation: an unfinished control frame
// must not become an unbounded second PTY buffer. Oversized frames are discarded,
// never emitted as a complete command with silently truncated text.
export const MAX_SHELL_INTEGRATION_FRAME_BYTES = 512 * 1024;
type ParsedSequence = ShellIntegrationSequence | { kind: "frame-discarded" };

/* eslint-disable no-control-regex -- OSC 133/633 frames use ESC and BEL */
const OSC_START = /\u001b\](?:133|633);/u;
const ST_OR_BEL = /\u0007|\u001b\\|\u009c/u;

export const varinShellIntegrationId = (terminalId: string, generation: number): string => (
  `${terminalId}:${generation}`
);

export const formatVarinOscFrame = (integrationId: string, body: string): string => (
  `\u001b]633;pi;${integrationId};${body}\u0007`
);

export const decodeShellIntegrationPayload = (value: string): string => {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const hex = value.slice(index + 1, index + 4);
    if (/^x[0-9a-fA-F]{2}$/u.test(hex)) {
      decoded += String.fromCharCode(Number.parseInt(hex.slice(1), 16));
      index += 3;
      continue;
    }
    decoded += value[index + 1] ?? "";
    index += 1;
  }
  return decoded;
};

export const encodeShellIntegrationPayload = (value: string): string => (
  value.replace(/\\/gu, "\\\\").replace(/;/gu, "\\x3b")
);

export const parseShellIntegrationBody = (body: string): ShellIntegrationSequence | null => {
  if (body === "A") return { kind: "prompt-start" };
  if (body === "B") return { kind: "command-start" };
  if (body === "C") return { kind: "command-executed" };
  if (body === "D") return { kind: "command-finished", exitCode: 0 };
  if (body.startsWith("D;")) {
    const code = Number.parseInt(body.slice(2), 10);
    if (!Number.isInteger(code)) return null;
    return { kind: "command-finished", exitCode: code };
  }
  if (body.startsWith("E;")) {
    return { kind: "command-line", command: decodeShellIntegrationPayload(body.slice(2)) };
  }
  if (body.startsWith("P;")) {
    for (const part of body.slice(2).split(";")) {
      if (part.startsWith("Cwd=")) {
        return { kind: "cwd", cwd: decodeShellIntegrationPayload(part.slice(4)) };
      }
    }
  }
  return null;
};

export const parseVarinShellIntegrationBody = (
  raw: string,
  expectedId: string,
): ShellIntegrationSequence | null => {
  const prefix = `pi;${expectedId};`;
  if (!raw.startsWith(prefix)) return null;
  return parseShellIntegrationBody(raw.slice(prefix.length));
};

const consumeOscChunk = (
  pending: string,
  data: string,
  expectedId: string,
  discarding: boolean,
): { pending: string; discarding: boolean; sequences: ParsedSequence[] } => {
  const input = `${pending}${data}`;
  const sequences: ParsedSequence[] = [];
  let cursor = 0;
  if (discarding) {
    const end = input.search(ST_OR_BEL);
    if (end < 0) return { pending: input.endsWith("\u001b") ? "\u001b" : "", discarding: true, sequences };
    cursor = end + (input[end] === "\u001b" ? 2 : 1);
  }
  while (cursor < input.length) {
    const match = OSC_START.exec(input.slice(cursor));
    if (!match || match.index === undefined) {
      const tail = input.slice(Math.max(cursor, input.length - 8));
      return { pending: /\u001b(?:\](?:[16](?:3(?:3)?)?)?)?$/u.exec(tail)?.[0] ?? "", discarding: false, sequences };
    }
    const absolute = cursor + match.index;
    const bodyStart = absolute + match[0].length;
    const rest = input.slice(bodyStart);
    const end = rest.search(ST_OR_BEL);
    if (end < 0) {
      const frame = input.slice(absolute);
      if (Buffer.byteLength(frame) <= MAX_SHELL_INTEGRATION_FRAME_BYTES) return { pending: frame, discarding: false, sequences };
      sequences.push({ kind: "frame-discarded" });
      return { pending: input.endsWith("\u001b") ? "\u001b" : "", discarding: true, sequences };
    }
    const terminator = rest[end] === "\u001b" ? 2 : 1;
    if (Buffer.byteLength(input.slice(absolute, bodyStart + end + terminator)) > MAX_SHELL_INTEGRATION_FRAME_BYTES) {
      sequences.push({ kind: "frame-discarded" });
    } else {
      const parsed = parseVarinShellIntegrationBody(rest.slice(0, end), expectedId);
      if (parsed) sequences.push(parsed);
    }
    cursor = bodyStart + end + terminator;
  }
  return { pending: "", discarding: false, sequences };
};

export function createShellIntegrationParser(options: {
  now?: () => number;
  terminalId: string;
}): {
  consume(data: string): TerminalCommandObservation[];
  reset(generation: number): void;
  status(): ShellIntegrationStatus;
  discardedFrames(): number;
} {
  const now = options.now ?? Date.now;
  let pending = "";
  let discarding = false;
  let discardedFrames = 0;
  let generation = 0;
  let sequence = 0;
  let status: ShellIntegrationStatus = "not-observed";
  let cwd: string | undefined;
  let command: string | undefined;
  let startedAt: number | undefined;
  let awaitingFinish = false;

  const expectedId = (): string => varinShellIntegrationId(options.terminalId, generation);

  const finish = (exitCode: number, endedAt: number): TerminalCommandObservation | null => {
    if (!awaitingFinish || typeof command !== "string" || command.length === 0) {
      awaitingFinish = false;
      command = undefined;
      startedAt = undefined;
      return null;
    }
    sequence += 1;
    const observation: TerminalCommandObservation = {
      command,
      commandId: `${options.terminalId}:${generation}:${sequence}`,
      endedAt,
      exitCode,
      integration: "osc-633",
      terminalId: options.terminalId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(startedAt === undefined ? {} : { startedAt }),
    };
    awaitingFinish = false;
    command = undefined;
    startedAt = undefined;
    return observation;
  };

  return {
    consume(data: string) {
      const parsed = consumeOscChunk(pending, data, expectedId(), discarding);
      pending = parsed.pending;
      discarding = parsed.discarding;
      const finished: TerminalCommandObservation[] = [];
      for (const item of parsed.sequences) {
        if (item.kind === "frame-discarded") {
          discardedFrames += 1;
          command = undefined; startedAt = undefined; awaitingFinish = false;
          continue;
        }
        status = "ready";
        if (item.kind === "cwd") {
          cwd = item.cwd;
          continue;
        }
        if (item.kind === "command-line") {
          command = item.command;
          awaitingFinish = true;
          startedAt = startedAt ?? now();
          continue;
        }
        if (item.kind === "command-start" || item.kind === "command-executed") {
          awaitingFinish = true;
          startedAt = startedAt ?? now();
          continue;
        }
        if (item.kind === "command-finished") {
          const observation = finish(item.exitCode, now());
          if (observation) finished.push(observation);
        }
      }
      return finished;
    },
    reset(nextGeneration: number) {
      generation = nextGeneration;
      sequence = 0;
      pending = "";
      discarding = false;
      discardedFrames = 0;
      status = "not-observed";
      cwd = undefined;
      command = undefined;
      startedAt = undefined;
      awaitingFinish = false;
    },
    status: () => status,
    discardedFrames: () => discardedFrames,
  };
}
