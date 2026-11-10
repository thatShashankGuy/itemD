import {
  COMMAND_TIMEOUT_MS,
  executeCommand,
  type CommandResult,
} from "../execution/command.ts";
import { parseShellInput } from "../execution/shell-input.ts";
import type { ToolResult } from "../tools/contracts.ts";

export async function executePrefixedShellCommand(
  input: string,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<ToolResult<CommandResult>> {
  const parsed = parseShellInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        code: "INVALID_TOOL_CALL",
        message: parsed.message,
      },
    };
  }

  const result = await executeCommand(
    parsed.executable,
    parsed.args,
    workspaceRoot,
    COMMAND_TIMEOUT_MS,
    undefined,
    signal,
  );

  if (result.ok) {
    return { ok: true, output: result };
  }

  return {
    ok: false,
    error: {
      code: result.cancelled
        ? "COMMAND_CANCELLED"
        : result.timedOut
          ? "COMMAND_TIMED_OUT"
          : "COMMAND_FAILED",
      message: result.cancelled
        ? "Command cancelled"
        : result.timedOut
          ? `Command exceeded ${COMMAND_TIMEOUT_MS}ms`
          : result.error?.message ||
            result.stderr ||
            `Command exited with code ${result.exitCode}`,
      details: result,
    },
  };
}

export function formatShellResult(
  input: string,
  result: ToolResult<CommandResult>,
): string {
  if (!result.ok) {
    return `$ !${input}\n[shell error] ${result.error.message}`;
  }

  const command = result.output;
  const sections = [`$ !${input}`];

  if (command.stdout.length > 0) {
    sections.push(command.stdout.trimEnd());
  }

  if (command.stderr.length > 0) {
    sections.push(`[stderr]\n${command.stderr.trimEnd()}`);
  }

  sections.push(
    `[exit ${command.exitCode ?? "unknown"}] ${command.durationMs}ms` +
      (command.stdoutTruncated || command.stderrTruncated
        ? " • output truncated"
        : ""),
  );

  return sections.join("\n");
}
