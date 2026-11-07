import { spawn } from "node:child_process";
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
