import { spawn } from 'node:child_process'

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationms: number;
  cwd: string;
}

export function executeCommand(
  executable: string,
  args: string[],
  cwd:string
): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell:false
    })

    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(error));

    child.on("close", (exitCode) => {
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? -1,
        durationms: Date.now() - startedAt,
        cwd
      })
    })

  })

}
