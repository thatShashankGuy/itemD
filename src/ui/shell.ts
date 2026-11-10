import type { CommandResult } from "../execution/command.ts";
import { parseShellInput } from "../execution/shell-input.ts";
import { executeTool } from "../tools/dispatcher.ts";
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

  return executeTool(
    {
      type: "shell",
      executable: parsed.executable,
      args: parsed.args,
    },
    workspaceRoot,
    signal,
    { shellMode: "auto" },
  ) as Promise<ToolResult<CommandResult>>;
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
