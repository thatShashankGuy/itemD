import { spawn } from "node:child_process";
import { spawn as spawnPty, type IPty } from "node-pty";
import { getErrorMessage } from "../shared/runtime.ts";

export const COMMAND_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 1_000;
const MAX_OUTPUT_CHARS = 100_000;

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  cwd: string;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: {
    code: "SPAWN_FAILED";
    message: string;
  };
};

function appendBounded(
  current: string,
  chunk: unknown,
  limit: number,
): { value: string; truncated: boolean } {
  const text = String(chunk);
  const remaining = limit - current.length;

  if (remaining <= 0) {
    return { value: current, truncated: true };
  }

  if (text.length > remaining) {
    return {
      value: current + text.slice(0, remaining),
      truncated: true,
    };
  }

  return {
    value: current + text,
    truncated: false,
  };
}

function executePtyCommand(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  outputLimit: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const startedAt = Date.now();

  if (signal?.aborted) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      durationMs: 0,
      cwd,
      timedOut: false,
      cancelled: true,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  }

  let terminal: IPty;
  try {
    terminal = spawnPty(executable, args, {
      cols: 120,
      rows: 40,
      cwd,
      name: "xterm-256color",
      env: process.env,
    });
  } catch (error: unknown) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      cwd,
      timedOut: false,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      error: {
        code: "SPAWN_FAILED",
        message: getErrorMessage(error),
      },
    });
  }

  return new Promise<CommandResult>((resolveResult) => {
    let stdout = "";
    let stdoutTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    function terminateTerminal(): void {
      try {
        terminal.kill();
      } catch {
        // The process may already have exited.
      }

      forceKillTimer ??= setTimeout(() => {
        try {
          terminal.kill();
        } catch {
          // The process may already have exited.
        }
      }, FORCE_KILL_DELAY_MS);
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateTerminal();
    }, timeoutMs);
    const abortHandler = (): void => {
      cancelled = true;
      terminateTerminal();
    };

    signal?.addEventListener("abort", abortHandler, { once: true });

    const dataSubscription = terminal.onData((chunk) => {
      const next = appendBounded(stdout, chunk, outputLimit);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });

    terminal.onExit(({ exitCode, signal: exitSignal }) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", abortHandler);
      dataSubscription.dispose();

      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }

      resolveResult({
        ok: exitCode === 0 && !timedOut && !cancelled,
        stdout,
        stderr: "",
        exitCode,
        signal: exitSignal === undefined ? null : String(exitSignal),
        durationMs: Date.now() - startedAt,
        cwd,
        timedOut,
        cancelled,
        stdoutTruncated,
        stderrTruncated: false,
      });
    });
  });
}

/**
 * Runs a command directly, without a shell, and captures a bounded result.
 * Expected process failures resolve as data instead of rejecting the promise.
 */
export function executeCommand(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
  outputLimit = MAX_OUTPUT_CHARS,
  signal?: AbortSignal,
  pty = false,
): Promise<CommandResult> {
  const startedAt = Date.now();

  if (signal?.aborted) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      durationMs: 0,
      cwd,
      timedOut: false,
      cancelled: true,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  }

  if (pty) {
    return executePtyCommand(
      executable,
      args,
      cwd,
      timeoutMs,
      outputLimit,
      signal,
    );
  }

  return new Promise<CommandResult>((resolveResult) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    function terminateChild(): void {
      child.kill("SIGTERM");

      if (forceKillTimer === undefined) {
        forceKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, FORCE_KILL_DELAY_MS);
      }
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, timeoutMs);
    const abortHandler = (): void => {
      cancelled = true;
      terminateChild();
    };

    signal?.addEventListener("abort", abortHandler, { once: true });

    function clearTimers(): void {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", abortHandler);

      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendBounded(stdout, chunk, outputLimit);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendBounded(stderr, chunk, outputLimit);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });

    child.on("error", (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();

      resolveResult({
        ok: false,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        cwd,
        timedOut,
        cancelled,
        stdoutTruncated,
        stderrTruncated,
        error: {
          code: "SPAWN_FAILED",
          message: getErrorMessage(error),
        },
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();

      resolveResult({
        ok: exitCode === 0 && !timedOut && !cancelled,
        stdout,
        stderr,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        cwd,
        timedOut,
        cancelled,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}
