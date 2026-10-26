import {
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { executeCommand } from "./shell.ts";

export type ToolCall =
  {
    type: "read_file";
    path: string;
  } | {
    type: "write_file";
    path: string;
    content: string;
  } | {
    type: "list_file";
    path:string
  } | {
    type: "shell";
    executable: string;
    args: string[];
  };

export type ToolResult = {
  ok: true;
  output: string;
} | {
  ok: false;
  error: string;
};


export async function executeTool(
  call: ToolCall,
  cwd: string,
): Promise<ToolResult> {
  try {
    switch (call.type) {
      case "list_file": {
        const directoryPath = resolve(cwd, call.path);
        const entries = await readdir(directoryPath, {
          withFileTypes: true,
        });
        const output = entries
          .map((entry) => {
            return entry.isDirectory() ? `${entry.name}/` : entry.name;
          })
          .join("\n");

        return {
          ok: true,
          output,
        };
      }

      case "read_file": {
        const filePath = resolve(cwd, call.path);
        const content = await readFile(filePath, "utf8");

        return {
          ok: true,
          output: content,
        };
      }

      case "write_file": {
        const filePath = resolve(cwd, call.path);
        await writeFile(filePath, call.content, "utf8");

        return {
          ok: true,
          output: `Wrote ${call.path}`,
        };
      }

      case "shell": {
        const result = await executeCommand(
          call.executable,
          call.args,
          cwd,
        );

        if (result.exitCode !== 0) {
          return {
            ok: false,
            error:
              result.stderr ||
              result.stdout ||
              `Command exited with code ${result.exitCode}`,
          };
        }

        return {
          ok: true,
          output: result.stdout,
        };
      }

      default:
        return {
          ok: false,
          error: "No valid tool",
        };
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: getErrorMessage(error),
    };
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
